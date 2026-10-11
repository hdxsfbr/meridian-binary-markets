/**
 * `morning` job (contracts/automation.md, tasks.md T068/T070): for every
 * enabled ticker, reads the previous close, derives the strike ladder, and
 * creates a market (then its book) for every strike -- all tickers and all
 * strikes regardless of `DEMO_SCALE` (only the book capacity changes).
 * Per-ticker try/catch (FR-004): one ticker's failure never blocks the
 * others. Idempotent: a market whose PDA already exists still has
 * `createBookUntilDone` called on it (fix #9) rather than being skipped
 * outright, since `create_book` is itself idempotent/resumable and an
 * earlier run may have created the market but not finished its book.
 *
 * PRD §5.3 alerting: if a ticker's ladder cannot be completed -- its
 * previous-close read never succeeds, or any strike's `create_market`/
 * `create_book` fails even after `retry` -- one alert is sent for that
 * ticker via `../alert.js` (the same module and `alertWebhookUrl`/`alertFn`
 * shape as the settle job), naming the ticker, trading day, which strikes
 * failed, and the last error. Alerts are sent only after every ticker has
 * been attempted, so one bad ticker never blocks or delays the others, and a
 * throwing `alertFn` is caught and logged, never allowed to fail the job.
 */

import type { PublicKey } from "@solana/web3.js";
import { strikeLadder, type Ticker } from "@meridian/sdk";
import { withRetry } from "../chain.js";
import { closeTs as closeTsOf, isTradingDay, staticHolidaysFor, tradingDayOf } from "../calendar.js";
import { log, logError } from "../log.js";
import { alert as defaultAlert, type AlertInput } from "../alert.js";
import type { PriceProvider } from "../providers/PriceProvider.js";

const DEMO_BOOK_CAPACITY = 16;

export interface MorningChain {
  /** `null` if no market exists yet at this PDA. */
  fetchMarket(pubkey: PublicKey): Promise<{ book: PublicKey } | null>;
  marketAddress(ticker: Ticker, tradingDay: number, strike: bigint): PublicKey;
  createMarket(ticker: Ticker, strike: bigint, tradingDay: number, closeTs: number, capacity: number): Promise<PublicKey>;
  createBookUntilDone(market: PublicKey): Promise<void>;
  fetchConfig(): Promise<{
    tickers: Array<{ symbol: Ticker; enabled: boolean }>;
    defaultBookCapacity: number;
  }>;
}

export interface MorningJobDeps {
  chain: MorningChain;
  provider: PriceProvider;
  demoScale: boolean;
  now?: () => number;
  /** Injectable retry wrapper, for tests that want to skip real backoff delays. */
  retry?: <T>(fn: () => Promise<T>) => Promise<T>;
  alertWebhookUrl?: string;
  alertFn?: (input: AlertInput, webhookUrl: string | undefined) => Promise<void>;
}

export interface MorningJobOptions {
  /** `YYYYMMDD` override; defaults to today (ET). */
  day?: number;
  /**
   * Demo flag: `close_ts = now + closeInSeconds` instead of 16:00:00 ET.
   * The only path where a market's close is not 16:00 ET
   * (contracts/automation.md "CLI entry points"). Positive integers only
   * (fix #11), and only meaningful together with an explicit synthetic
   * `day` that is not today's real trading day.
   */
  closeInSeconds?: number;
  /**
   * Bypasses the trading-day check (fix #10) so `--day` can be used to
   * create a synthetic demo day that would otherwise be refused (e.g. a
   * weekend or holiday).
   */
  force?: boolean;
}

/** The static-fallback NYSE holiday set for `tradingDay`'s year (fix #10). */
function holidaysForYear(tradingDay: number): Set<string> {
  const year = Number(String(tradingDay).slice(0, 4));
  try {
    // The Pyth feed schedule is the primary source for holidays (R9); fetching it is not wired
    // up in this wave (mock-provider only), so the static fallback is used directly, same as
    // publisher.ts's isWithinPublishWindow.
    return staticHolidaysFor(year);
  } catch {
    // Unsupported year in the static table: fail closed as "no known holidays" rather than
    // crash the job -- isTradingDay then falls back to a plain weekday check.
    return new Set();
  }
}

/**
 * Sends one morning-ladder alert via the same alert module/shape the settle job uses. Never
 * throws into the caller -- a throwing (or rejecting) `alertFn` is caught and logged instead,
 * same guarantee as settle's own alert path.
 */
async function sendLadderAlert(
  deps: Pick<MorningJobDeps, "alertFn" | "alertWebhookUrl">,
  input: AlertInput,
): Promise<void> {
  const alertFn = deps.alertFn ?? defaultAlert;
  try {
    await alertFn(input, deps.alertWebhookUrl);
  } catch (err) {
    logError({
      job: "morning",
      ticker: input.ticker,
      step: "alert",
      ok: false,
      error: `alertFn threw: ${(err as Error).message ?? String(err)}`,
    });
  }
}

export async function runMorningJob(deps: MorningJobDeps, opts: MorningJobOptions = {}): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const retry = deps.retry ?? (<T>(fn: () => Promise<T>) => withRetry(fn));
  const nowSeconds = Math.floor(now() / 1000);
  const tradingDay = opts.day ?? tradingDayOf(nowSeconds);

  // Fix #11: --close-in validation -- positive integer only, only ever alongside an explicit
  // synthetic --day, and never on the real current trading day.
  if (opts.closeInSeconds !== undefined) {
    if (!Number.isInteger(opts.closeInSeconds) || opts.closeInSeconds <= 0) {
      throw new Error(
        `morning: --close-in must be a positive integer number of seconds, got ${opts.closeInSeconds}`,
      );
    }
    if (opts.day === undefined) {
      throw new Error("morning: --close-in is only allowed together with --day (a synthetic trading day)");
    }
    const realToday = tradingDayOf(nowSeconds);
    if (opts.day === realToday) {
      throw new Error(
        `morning: --close-in is never allowed on the real current trading day (${realToday}); use a synthetic --day`,
      );
    }
  }

  // Fix #10: normal runs (and explicit --day runs) refuse to create markets on a non-trading
  // day, unless --force is passed (the demo's deliberate escape hatch for synthetic days).
  if (!opts.force && !isTradingDay(tradingDay, holidaysForYear(tradingDay))) {
    log({
      job: "morning",
      step: "trading_day_check",
      ok: true,
      error: `${tradingDay} is not a trading day; exiting without creating markets (use --force to override)`,
    });
    return;
  }

  if (opts.closeInSeconds !== undefined) {
    // Loud by design (fix #11): this is a demo-only deviation from the normal 16:00 ET close,
    // and it must be obvious in the logs that it happened.
    log({
      job: "morning",
      step: "close_override",
      ok: true,
      error:
        `DEMO OVERRIDE ACTIVE: close_ts = now + ${opts.closeInSeconds}s on synthetic trading day ` +
        `${tradingDay}, NOT the real 16:00:00 ET close`,
    });
  }

  const config = await deps.chain.fetchConfig();
  const capacity = deps.demoScale ? DEMO_BOOK_CAPACITY : config.defaultBookCapacity;

  const closeTs = opts.closeInSeconds !== undefined ? nowSeconds + opts.closeInSeconds : closeTsOf(tradingDay);

  const enabledTickers = config.tickers.filter((t) => t.enabled).map((t) => t.symbol);

  await Promise.all(
    enabledTickers.map(async (ticker) => {
      try {
        const prevClose = await deps.provider.previousClose(ticker);
        const strikes = strikeLadder(prevClose);

        let createdCount = 0;
        let existingCount = 0;
        let skippedCount = 0;
        // One alert per ticker, sent once the whole ladder has been attempted (PRD §5.3):
        // which strikes failed, and the last error seen for any of them.
        const failedStrikes: string[] = [];
        let lastStrikeError: string | undefined;

        for (const strike of strikes) {
          // Fix #12: a single strike's create_market failure (e.g. the strike key was reused by
          // an earlier closed market whose SPL mint PDAs can't be closed and therefore can't be
          // recreated) must not abort the rest of the ticker's strike ladder. Each strike is its
          // own try/catch inside the ticker loop.
          try {
            const marketAddr = deps.chain.marketAddress(ticker, tradingDay, strike);
            let market: PublicKey;

            const existing = await deps.chain.fetchMarket(marketAddr);
            if (existing) {
              market = marketAddr;
              existingCount += 1;
              log({
                job: "morning",
                ticker,
                market: market.toBase58(),
                step: "create_market",
                ok: true,
                error: "market already exists (idempotent re-run); ensuring its book is finished",
              });
            } else {
              try {
                market = await retry(() => deps.chain.createMarket(ticker, strike, tradingDay, closeTs, capacity));
                createdCount += 1;
                log({ job: "morning", ticker, market: market.toBase58(), step: "create_market", ok: true });
              } catch (err) {
                // Fix #9: an ambiguous transaction failure (e.g. a missed confirmation) does not
                // necessarily mean the market wasn't actually created on chain. Re-fetch the PDA
                // before concluding it's a real failure.
                const refetched = await deps.chain.fetchMarket(marketAddr);
                if (refetched) {
                  market = marketAddr;
                  existingCount += 1;
                  log({
                    job: "morning",
                    ticker,
                    market: market.toBase58(),
                    step: "create_market",
                    ok: true,
                    error: "create_market transaction reported failure but the market exists on chain; proceeding",
                  });
                } else {
                  throw err;
                }
              }
            }

            // Fix #9: always call createBookUntilDone, including for a market that already
            // existed -- create_book is itself idempotent/resumable, so this is never wasted work,
            // and it is the only way an earlier run's unfinished book ever gets completed.
            await retry(() => deps.chain.createBookUntilDone(market));
            log({ job: "morning", ticker, market: market.toBase58(), step: "create_book", ok: true });
          } catch (err) {
            skippedCount += 1;
            const message = (err as Error).message ?? String(err);
            const strikeDollars = (Number(strike) / 1_000_000).toFixed(2);
            const alreadyInUse = message.includes("already in use");
            const loggedError = alreadyInUse
              ? "strike key was used by an earlier closed market (its token mints still exist); skipping this strike"
              : message;
            logError({
              job: "morning",
              ticker,
              step: "strike",
              strike: strikeDollars,
              ok: false,
              error: loggedError,
            });
            failedStrikes.push(strikeDollars);
            lastStrikeError = loggedError;
          }
        }

        log({
          job: "morning",
          ticker,
          step: "ticker_summary",
          ok: true,
          error: `created=${createdCount} existing=${existingCount} skipped=${skippedCount}`,
        });

        if (failedStrikes.length > 0) {
          await sendLadderAlert(deps, {
            job: "morning",
            ticker,
            summary: `morning ladder incomplete for trading day ${tradingDay}`,
            error: `strike(s) ${failedStrikes.join(", ")} failed; last error: ${lastStrikeError}`,
          });
        }
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        logError({ job: "morning", ticker, step: "ticker", ok: false, error: message });
        await sendLadderAlert(deps, {
          job: "morning",
          ticker,
          summary: `morning ladder incomplete for trading day ${tradingDay}`,
          error: `previous-close read failed: ${message}`,
        });
      }
    }),
  );
}
