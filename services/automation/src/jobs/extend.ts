/**
 * `extend` job (DECISIONS.md §27): an intraday ladder-extension tick. Every 5 minutes,
 * 09:35-15:45 ET on trading days, checks whether the live price has drifted up to (or
 * past) the top of a ticker's existing strike ladder for today, or down to (or past) the
 * bottom, and -- if that condition holds on two *consecutive, scheduled* ticks -- adds
 * one strike above or below, using the same magnitude-dependent grid `strikeLadder`
 * (packages/sdk/src/strikes.ts's `strikeStepFor`) rounds to -- $10/$100/$500 depending on the
 * ladder's price level (DECISIONS.md section 30). This never removes a strike; "Add strike" on
 * the Admin page remains the manual, operator-driven path for anything this heuristic doesn't
 * cover.
 *
 * A ticker with no markets for today is left alone entirely -- `morning` (jobs/morning.ts)
 * owns initial creation, this job only ever extends an already-created ladder.
 *
 * State (the two-consecutive-tick counters, the per-day creation cap, and the pending-book
 * set -- see each field's doc comment on `ExtendState`) is kept by the caller and threaded
 * in via `deps.state`, rather than module-level globals, so `index.ts` can own one
 * long-lived instance across cron ticks while tests get a fresh one per test with no
 * cross-test leakage. `loadExtendState`/`saveExtendState` persist it to a small JSON file
 * so a worker restart (or two manual `job extend --once` invocations) don't reset it
 * (review fix #9/DECISIONS §27).
 *
 * Creation itself mirrors `jobs/morning.ts`'s per-strike shape exactly: `fetchMarket`
 * before `createMarket` (idempotent re-run), the ambiguous-failure re-fetch, and the
 * "already in use" skip for a strike key reused by an earlier closed market's still-live
 * token mints -- except logged under `step: "create_market" | "create_book" | "skip" |
 * "summary"` (DECISIONS §27) instead of morning's `"strike"`/`"ticker_summary"`.
 *
 * Review fixes (codex review of the uncommitted diff, see DECISIONS §27):
 *   1. The per-ticker-per-day allowance is reserved *before* `createMarket` is called, not
 *      after `createBookUntilDone` succeeds -- a created market spends rent (and therefore
 *      consumes the day's allowance) even if its book never finishes.
 *   2. A market whose book fails is tracked in `state.bookPending` and retried on every
 *      later tick, independently of edge detection and the cap, and is excluded from edge
 *      detection (the ladder's "top"/"bottom") until its book completes -- so a later tick
 *      never targets the strike beyond an unfinished one.
 *   3. The two-consecutive-tick streak is keyed by trading day (reset wholesale on a day
 *      change) and requires the two hits to be *consecutive scheduled ticks* -- within 1.5x
 *      the 5-minute interval of each other -- not merely two hits at any point in time. A
 *      failed/skipped observation clears the streak outright.
 *   4. A trading day with no static NYSE holiday entry fails *closed* (treated as not a
 *      trading day, logged once per day at error level) rather than silently treating an
 *      unknown year as holiday-free.
 *   5. `createGuardedExtendTick` wraps `runExtendTick` with an in-flight guard, released in
 *      `finally`: a slow tick (slow RPC calls, a book-retry loop) can never overlap with
 *      the next scheduled one, which would otherwise share `state` with no synchronization.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { PublicKey } from "@solana/web3.js";
import { PublicKey as PublicKeyCtor } from "@solana/web3.js";
import type { Ticker } from "@meridian/sdk";
import { strikeStepFor } from "@meridian/sdk";
import { withRetry } from "../chain.js";
import { ET_ZONE, isTradingDay, staticHolidaysFor, tradingDayOf } from "../calendar.js";
import { log, logError } from "../log.js";
import type { PriceProvider } from "../providers/PriceProvider.js";
import { DateTime } from "luxon";

/** Same demo book capacity as `jobs/morning.ts`'s `DEMO_BOOK_CAPACITY`. */
const DEMO_BOOK_CAPACITY = 16;

/** Cap on strikes this job will add per ticker per trading day (DECISIONS §27). */
export const MAX_EXTENSIONS_PER_DAY = 2;

/** 09:35-15:45 ET: the intraday window `extend` ticks within. */
const WINDOW_START = { hour: 9, minute: 35 };
const WINDOW_END = { hour: 15, minute: 45 };

/**
 * The cron/CLI tick cadence, in seconds (index.ts's five-minute cron schedule). Review fix
 * #3: two streak-confirming observations must land within `EXTEND_INTERVAL_SECS * 1.5` of
 * each other to count as "consecutive scheduled ticks" -- a gap wider than that means at
 * least one tick was missed (a slow RPC call, a restart, a long `--once` gap) and the
 * streak must not silently span it.
 */
export const EXTEND_INTERVAL_SECS = 5 * 60;

/** Review fix #3: the maximum gap between two streak-confirming ticks, in seconds. */
const MAX_TICK_GAP_SECS = EXTEND_INTERVAL_SECS * 1.5;

export interface ExtendMarketSummary {
  ticker: Ticker;
  strike: bigint;
  closeTs: number;
}

export interface ExtendChain {
  /** `null` if no market exists yet at this PDA. */
  fetchMarket(pubkey: PublicKey): Promise<{ book: PublicKey } | null>;
  marketAddress(ticker: Ticker, tradingDay: number, strike: bigint): PublicKey;
  createMarket(ticker: Ticker, strike: bigint, tradingDay: number, closeTs: number, capacity: number): Promise<PublicKey>;
  createBookUntilDone(market: PublicKey): Promise<void>;
  fetchConfig(): Promise<{
    tickers: Array<{ symbol: Ticker; enabled: boolean }>;
    defaultBookCapacity: number;
  }>;
  /** Today's `Open` markets (all tickers); `jobs/settle.ts`/`jobs/reclaim.ts` enumerate the same way. */
  fetchOpenMarkets(tradingDay: number): Promise<Array<{ publicKey: PublicKey; account: ExtendMarketSummary }>>;
}

/** Per-ticker two-consecutive-tick tracking for one pending extension candidate. */
interface ConsecutiveHit {
  direction: "above" | "below";
  strike: bigint;
  count: number;
  /** Trading day this hit was recorded on (review fix #3: streaks never span a day change). */
  day: number;
  /** `nowSeconds` this hit was recorded at (review fix #3: bounds the gap to the next hit). */
  lastTickAt: number;
}

/** Per-ticker per-day count of strikes this job has actually added. */
interface DailyCount {
  day: number;
  count: number;
}

/**
 * A market created by this job whose `createBookUntilDone` has not yet succeeded (review
 * fix #2). Keyed by the market's base58 address in `ExtendState.bookPending`. Retried on
 * every tick for its ticker, independently of edge detection and the per-day cap, and
 * excluded from edge detection until it clears.
 */
interface PendingBook {
  ticker: Ticker;
  strike: bigint;
  tradingDay: number;
  closeTs: number;
  capacity: number;
}

/**
 * Cross-tick memory for `runExtendTick`. `index.ts` owns one instance for the life of the
 * process (loaded from/saved to `EXTEND_STATE_PATH` -- review fix #9 -- so a restart no
 * longer silently resets the cap/streaks); tests create a fresh one per test via
 * `createExtendState()`.
 */
export interface ExtendState {
  consecutive: Map<Ticker, ConsecutiveHit>;
  dailyCreated: Map<Ticker, DailyCount>;
  /** Review fix #2: markets created but not yet booked, retried every tick. */
  bookPending: Map<string, PendingBook>;
  /** Review fix #3: the trading day streaks were last evaluated on; a change clears all of them. */
  day: number | null;
  /** Review fix #4: the trading day a missing-holiday-year error was last logged for (dedupe). */
  loggedMissingHolidayDay: number | null;
}

export function createExtendState(): ExtendState {
  return {
    consecutive: new Map(),
    dailyCreated: new Map(),
    bookPending: new Map(),
    day: null,
    loggedMissingHolidayDay: null,
  };
}

export interface ExtendJobDeps {
  chain: ExtendChain;
  provider: PriceProvider;
  demoScale: boolean;
  /** Cross-tick state; see `ExtendState`'s doc comment. */
  state: ExtendState;
  now?: () => number;
  /** Injectable retry wrapper, for tests that want to skip real backoff delays. */
  retry?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface ExtendTickOptions {
  /** `YYYYMMDD` override; defaults to today (ET). */
  day?: number;
  /** Bypasses the trading-day/time-window gate (the `job extend --once --force` CLI path). */
  force?: boolean;
}

/**
 * The static-fallback NYSE holiday set for `tradingDay`'s year, or `null` if this module
 * carries no static list for that year. Review fix #4: callers must treat `null` as "fail
 * closed" (not a trading day), never as "no known holidays" -- `morning.ts` keeps its own,
 * separate, pre-existing fail-open `holidaysForYear` (not shared with this one; left
 * unchanged, see this module's top doc comment and DECISIONS §27).
 */
function holidaysForYear(tradingDay: number): Set<string> | null {
  const year = Number(String(tradingDay).slice(0, 4));
  try {
    return staticHolidaysFor(year);
  } catch {
    return null;
  }
}

/**
 * True if `day` is a trading day, failing closed (logging once per day at error level, via
 * `state.loggedMissingHolidayDay`) when the static NYSE holiday table has no entry for
 * `day`'s year -- review fix #4. An unsupported year must never be treated as "no holidays
 * that year" (which would fail *open*, running the job on an actual holiday).
 */
function isTradingDayFailClosed(day: number, state: ExtendState): boolean {
  const holidays = holidaysForYear(day);
  if (holidays === null) {
    if (state.loggedMissingHolidayDay !== day) {
      state.loggedMissingHolidayDay = day;
      logError({
        job: "extend",
        step: "calendar",
        ok: false,
        error: `no static NYSE holiday list for year ${Number(String(day).slice(0, 4))} (trading day ${day}); ` +
          `treating ${day} as not a trading day (fail closed) rather than assuming no holidays`,
      });
    }
    return false;
  }
  return isTradingDay(day, holidays);
}

/**
 * True if `nowSeconds` falls within 09:35:00-15:45:00 ET on a trading day. `state` is
 * required so the fail-closed holiday-table check (review fix #4) can dedupe its once-
 * per-day log; pass a fresh `createExtendState()` for a pure/stateless check (e.g. tests
 * that only care about the time-of-day window).
 */
export function isWithinExtendWindow(nowSeconds: number, state: ExtendState = createExtendState()): boolean {
  const dt = DateTime.fromSeconds(nowSeconds, { zone: ET_ZONE });
  const day = tradingDayOf(nowSeconds);

  if (!isTradingDayFailClosed(day, state)) return false;

  const minutesOfDay = dt.hour * 60 + dt.minute;
  const startMinutes = WINDOW_START.hour * 60 + WINDOW_START.minute;
  const endMinutes = WINDOW_END.hour * 60 + WINDOW_END.minute;
  return minutesOfDay >= startMinutes && minutesOfDay <= endMinutes;
}

function dollars(strikeMicro: bigint): string {
  return (Number(strikeMicro) / 1_000_000).toFixed(2);
}

/**
 * Ensures `market` exists on chain for `ticker`/`strike`, in the exact idempotent/
 * ambiguous-failure-recovery shape `jobs/morning.ts` uses. Returns the market's `PublicKey`
 * plus whether it was already there (so the caller never double-reserves the day's
 * allowance -- review fix #1) and, on failure, whether the failure was the familiar
 * "already in use" strike-key collision (which still counts against the cap) by throwing a
 * tagged error.
 */
class AlreadyInUseError extends Error {}

async function ensureMarket(
  chain: ExtendChain,
  retry: <T>(fn: () => Promise<T>) => Promise<T>,
  ticker: Ticker,
  strike: bigint,
  tradingDay: number,
  closeTs: number,
  capacity: number,
): Promise<{ market: PublicKey; alreadyExisted: boolean }> {
  const marketAddr = chain.marketAddress(ticker, tradingDay, strike);
  const existing = await chain.fetchMarket(marketAddr);
  if (existing) {
    return { market: marketAddr, alreadyExisted: true };
  }

  try {
    const market = await retry(() => chain.createMarket(ticker, strike, tradingDay, closeTs, capacity));
    return { market, alreadyExisted: false };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Same ambiguous-failure recovery as morning.ts: re-fetch before concluding it failed.
    const refetched = await chain.fetchMarket(marketAddr);
    if (refetched) {
      return { market: marketAddr, alreadyExisted: false };
    }
    if (message.includes("already in use")) {
      throw new AlreadyInUseError(message);
    }
    throw err;
  }
}

/** Serialized, JSON-friendly shape of `ExtendState` (bigints as strings; Maps as entry arrays). */
interface SerializedExtendState {
  day: number | null;
  loggedMissingHolidayDay: number | null;
  consecutive: Array<[Ticker, Omit<ConsecutiveHit, "strike"> & { strike: string }]>;
  dailyCreated: Array<[Ticker, DailyCount]>;
  bookPending: Array<[string, Omit<PendingBook, "strike"> & { strike: string }]>;
}

/**
 * Loads `ExtendState` from `path` (review fix #9), so two manual `job extend --once`
 * invocations five minutes apart -- or a worker restart under the cron path -- can resume
 * an in-progress streak/cap rather than starting over. Returns a fresh `createExtendState()`
 * if the file doesn't exist or doesn't parse (first run, or Railway's ephemeral disk after a
 * redeploy) -- never throws.
 */
export async function loadExtendState(path: string): Promise<ExtendState> {
  try {
    const raw = await readFile(path, "utf8");
    const json = JSON.parse(raw) as SerializedExtendState;
    return {
      day: json.day ?? null,
      loggedMissingHolidayDay: json.loggedMissingHolidayDay ?? null,
      consecutive: new Map(json.consecutive.map(([k, v]) => [k, { ...v, strike: BigInt(v.strike) }])),
      dailyCreated: new Map(json.dailyCreated),
      bookPending: new Map(json.bookPending.map(([k, v]) => [k, { ...v, strike: BigInt(v.strike) }])),
    };
  } catch {
    return createExtendState();
  }
}

/**
 * Saves `state` to `path` atomically (temp file + rename, same pattern as
 * `events-index.ts`'s snapshot). Never throws -- a failed save just means the next tick
 * starts from the last successfully saved state (or a fresh one), logged rather than
 * crashing the job.
 */
export async function saveExtendState(path: string, state: ExtendState): Promise<void> {
  try {
    const payload: SerializedExtendState = {
      day: state.day,
      loggedMissingHolidayDay: state.loggedMissingHolidayDay,
      consecutive: Array.from(state.consecutive.entries()).map(([k, v]) => [k, { ...v, strike: v.strike.toString() }]),
      dailyCreated: Array.from(state.dailyCreated.entries()),
      bookPending: Array.from(state.bookPending.entries()).map(([k, v]) => [k, { ...v, strike: v.strike.toString() }]),
    };
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmpPath, JSON.stringify(payload));
    await rename(tmpPath, path);
  } catch (err) {
    logError({ job: "extend", step: "state_save", ok: false, error: (err as Error).message });
  }
}

/**
 * Retries every market pending a book for `ticker` (review fix #2), independently of edge
 * detection and the per-day cap -- a market that already spent its allowance keeps being
 * retried every tick until its book completes, with no further streak required.
 */
async function retryPendingBooks(
  deps: ExtendJobDeps,
  retry: <T>(fn: () => Promise<T>) => Promise<T>,
  ticker: Ticker,
): Promise<void> {
  for (const [marketKey, pending] of Array.from(deps.state.bookPending.entries())) {
    if (pending.ticker !== ticker) continue;
    try {
      await retry(() => deps.chain.createBookUntilDone(new PublicKeyCtor(marketKey)));
      deps.state.bookPending.delete(marketKey);
      log({
        job: "extend",
        ticker,
        market: marketKey,
        strike: dollars(pending.strike),
        step: "create_book",
        ok: true,
        error: "pending book completed on retry",
      });
    } catch (err) {
      logError({
        job: "extend",
        ticker,
        market: marketKey,
        strike: dollars(pending.strike),
        step: "create_book",
        ok: false,
        error: `book still not finished, will retry next tick: ${(err as Error).message}`,
      });
    }
  }
}

/**
 * One `extend` tick: for every enabled ticker that already has markets for today, checks
 * the live price against the top/bottom of today's ladder and extends it (above or below,
 * on the $10 grid) once the condition has held for two consecutive *scheduled* ticks --
 * capped at `MAX_EXTENSIONS_PER_DAY` strikes per ticker per day. Never removes anything. A
 * per-ticker try/catch (mirrors morning.ts's FR-004 shape): one ticker's failure never
 * blocks the others, and nothing ever throws out of this function.
 */
export async function runExtendTick(deps: ExtendJobDeps, opts: ExtendTickOptions = {}): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const retry = deps.retry ?? (<T>(fn: () => Promise<T>) => withRetry(fn));
  const nowSeconds = Math.floor(now() / 1000);
  const tradingDay = opts.day ?? tradingDayOf(nowSeconds);

  if (!opts.force && !isWithinExtendWindow(nowSeconds, deps.state)) {
    return;
  }

  // Review fix #3: streaks are keyed by trading day -- a day change resets all of them, so
  // yesterday's final hit can never combine with today's first hit.
  if (deps.state.day !== null && deps.state.day !== tradingDay) {
    deps.state.consecutive.clear();
  }
  deps.state.day = tradingDay;

  let config: { tickers: Array<{ symbol: Ticker; enabled: boolean }>; defaultBookCapacity: number };
  let openMarkets: Array<{ publicKey: PublicKey; account: ExtendMarketSummary }>;
  try {
    [config, openMarkets] = await Promise.all([deps.chain.fetchConfig(), deps.chain.fetchOpenMarkets(tradingDay)]);
  } catch (err) {
    logError({ job: "extend", step: "summary", ok: false, error: (err as Error).message });
    return;
  }

  const capacity = deps.demoScale ? DEMO_BOOK_CAPACITY : config.defaultBookCapacity;
  const enabledTickers = config.tickers.filter((t) => t.enabled).map((t) => t.symbol);

  await Promise.all(
    enabledTickers.map(async (ticker) => {
      try {
        // Review fix #2: pending-book retries run every tick, regardless of edge detection
        // or the cap.
        await retryPendingBooks(deps, retry, ticker);

        const tickerMarkets = openMarkets.filter((m) => m.account.ticker === ticker);
        if (tickerMarkets.length === 0) {
          // Ticker has no markets today -- morning.ts owns creation, extend never starts a ladder.
          return;
        }

        // Review fix #2: a market whose book hasn't finished is excluded from edge
        // detection, so a later tick never targets the strike beyond it.
        const completeMarkets = tickerMarkets.filter((m) => {
          const addr = deps.chain.marketAddress(ticker, tradingDay, m.account.strike).toBase58();
          return !deps.state.bookPending.has(addr);
        });
        if (completeMarkets.length === 0) {
          // Every market for this ticker today is still waiting on its book -- nothing
          // complete to measure the ladder's edge against yet.
          deps.state.consecutive.delete(ticker);
          return;
        }

        const strikes = completeMarkets.map((m) => m.account.strike);
        const highest = strikes.reduce((a, b) => (a > b ? a : b));
        const lowest = strikes.reduce((a, b) => (a < b ? a : b));
        // Same close time as the rest of today's ladder for this ticker -- never recomputed.
        const closeTs = completeMarkets.find((m) => m.account.strike === highest)!.account.closeTs;

        // Same grid `strikeLadder` derived this ticker's ladder on (packages/sdk/src/strikes.ts's
        // `strikeStepFor`), keyed off the ladder's own top strike -- every strike in `strikes` is
        // already a multiple of this step, so deriving it from any of them (the highest, here)
        // is equivalent to deriving it from the original previous close (DECISIONS.md §30).
        const stepMicro = strikeStepFor(highest);
        const halfStepMicro = stepMicro / 2n;

        let livePrice: bigint;
        try {
          livePrice = await deps.provider.currentPrice(ticker);
        } catch (err) {
          // Review fix #3: a failed observation clears the streak outright -- it is never
          // treated as "the condition cleared" (which would just not touch the streak) nor
          // as a silent gap that a later lucky pair of hits could bridge.
          deps.state.consecutive.delete(ticker);
          logError({ job: "extend", ticker, step: "summary", ok: false, error: (err as Error).message });
          return;
        }

        const aboveCondition = livePrice + halfStepMicro >= highest;
        const belowCondition = livePrice <= lowest + halfStepMicro;

        let direction: "above" | "below" | null = null;
        let targetStrike: bigint | null = null;
        if (aboveCondition) {
          direction = "above";
          targetStrike = highest + stepMicro;
        } else if (belowCondition) {
          direction = "below";
          targetStrike = lowest - stepMicro;
        }

        if (!direction || targetStrike === null) {
          // Condition cleared: reset the streak so a later approach needs two fresh ticks.
          deps.state.consecutive.delete(ticker);
          return;
        }

        const prev = deps.state.consecutive.get(ticker);
        // Review fix #3: the previous hit must be on the same trading day and within 1.5x the
        // tick interval -- a wider gap means at least one scheduled tick was missed, so this
        // is a fresh first hit, not a second consecutive one.
        const prevStillConsecutive =
          prev !== undefined &&
          prev.day === tradingDay &&
          nowSeconds - prev.lastTickAt <= MAX_TICK_GAP_SECS &&
          prev.direction === direction &&
          prev.strike === targetStrike;
        const count = prevStillConsecutive ? prev!.count + 1 : 1;

        if (count < 2) {
          deps.state.consecutive.set(ticker, { direction, strike: targetStrike, count, day: tradingDay, lastTickAt: nowSeconds });
          return;
        }

        // Two consecutive ticks confirmed -- reset the streak so the *next* extension (if any,
        // up to the per-day cap) again requires two fresh consecutive ticks of its own.
        deps.state.consecutive.delete(ticker);

        const dayState = deps.state.dailyCreated.get(ticker);
        const createdToday = dayState && dayState.day === tradingDay ? dayState.count : 0;

        const marketAddr = deps.chain.marketAddress(ticker, tradingDay, targetStrike);
        const existingMarket = await deps.chain.fetchMarket(marketAddr);

        if (!existingMarket && createdToday >= MAX_EXTENSIONS_PER_DAY) {
          log({
            job: "extend",
            ticker,
            strike: dollars(targetStrike),
            step: "skip",
            ok: true,
            error: `cap of ${MAX_EXTENSIONS_PER_DAY} added strikes/day reached for ${tradingDay}; not extending ${direction}`,
          });
          return;
        }

        let market: PublicKey;
        if (existingMarket) {
          market = marketAddr;
          log({
            job: "extend",
            ticker,
            market: market.toBase58(),
            strike: dollars(targetStrike),
            step: "create_market",
            ok: true,
            error: "market already exists (idempotent); ensuring its book is finished",
          });
        } else {
          // Review fix #1: reserve the allowance BEFORE calling createMarket -- a created
          // market consumes it even if its book never finishes (handled separately below).
          deps.state.dailyCreated.set(ticker, { day: tradingDay, count: createdToday + 1 });
          try {
            const result = await ensureMarket(deps.chain, retry, ticker, targetStrike, tradingDay, closeTs, capacity);
            market = result.market;
            log({ job: "extend", ticker, market: market.toBase58(), strike: dollars(targetStrike), step: "create_market", ok: true });
          } catch (err) {
            if (err instanceof AlreadyInUseError) {
              // An "already in use" strike key still counts against the per-day cap: the
              // attempt happened, even though this particular strike could never be
              // (re)created. The reservation above is kept as-is.
              logError({
                job: "extend",
                ticker,
                strike: dollars(targetStrike),
                step: "skip",
                ok: false,
                error: "strike key was used by an earlier closed market (its token mints still exist); skipping this strike",
              });
              return;
            }
            // Genuinely failed, and the re-fetch inside ensureMarket already confirmed no
            // market exists at this PDA: release the reservation (review fix #1) rather than
            // spending one of the day's two extensions on an attempt that never happened.
            deps.state.dailyCreated.set(ticker, { day: tradingDay, count: createdToday });
            logError({
              job: "extend",
              ticker,
              strike: dollars(targetStrike),
              step: "skip",
              ok: false,
              error: (err as Error).message ?? String(err),
            });
            return;
          }
        }

        try {
          await retry(() => deps.chain.createBookUntilDone(market));
          deps.state.bookPending.delete(market.toBase58());
          log({ job: "extend", ticker, market: market.toBase58(), strike: dollars(targetStrike), step: "create_book", ok: true });
          log({
            job: "extend",
            ticker,
            strike: dollars(targetStrike),
            step: "summary",
            ok: true,
            error: `direction=${direction} added_today=${createdToday + 1}/${MAX_EXTENSIONS_PER_DAY}`,
          });
        } catch (err) {
          // Review fix #2: the allowance was already spent (the market exists on chain) --
          // track it as a pending book, retried every later tick, rather than losing track
          // of an unfinished book entirely.
          deps.state.bookPending.set(market.toBase58(), {
            ticker,
            strike: targetStrike,
            tradingDay,
            closeTs,
            capacity,
          });
          logError({
            job: "extend",
            ticker,
            market: market.toBase58(),
            strike: dollars(targetStrike),
            step: "create_book",
            ok: false,
            error: `book did not finish, will retry every tick until it does: ${(err as Error).message}`,
          });
        }
      } catch (err) {
        logError({ job: "extend", ticker, step: "summary", ok: false, error: (err as Error).message });
      }
    }),
  );
}

/**
 * Wraps `runExtendTick` with an in-flight guard (review fix #5): if a previous tick
 * (invoked through the function this returns) hasn't finished yet, a new call logs
 * "skipped: previous tick still running" and returns immediately rather than starting a
 * second, overlapping tick against the same `ExtendState` -- `runExtendTick`'s per-tick
 * cap/streak bookkeeping assumes exactly one tick mutates `state` at a time.
 *
 * `getDeps` is called fresh on every invocation (not once up front), so callers can close
 * over a long-lived `state`/`chain`/`provider` the way `index.ts`'s cron callback does.
 * `onSettled` (if given) runs after every tick, successful or not, once the in-flight flag
 * has already been released -- `index.ts` uses it to persist `state` to `EXTEND_STATE_PATH`
 * (review fix #9) after each tick.
 */
export function createGuardedExtendTick(
  getDeps: () => ExtendJobDeps,
  opts: { tickOpts?: ExtendTickOptions; onSettled?: () => void } = {},
): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) {
      log({ job: "extend", step: "cron", ok: true, error: "skipped: previous tick still running" });
      return;
    }
    inFlight = true;
    runExtendTick(getDeps(), opts.tickOpts)
      .catch((err) => logError({ job: "extend", step: "cron", ok: false, error: (err as Error).message }))
      .finally(() => {
        inFlight = false;
        opts.onSettled?.();
      });
  };
}
