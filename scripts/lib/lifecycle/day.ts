/**
 * Synthetic trading day creation for `scripts/lifecycle.ts` (tasks.md T086,
 * step 4): for each requested ticker, derive a strike ladder from its
 * previous close and `create_market` + `create_book` every strike, with
 * `close_ts = now + closeInSeconds` (the demo's deliberate deviation from
 * the real 16:00 ET close -- see `services/automation/src/jobs/morning.ts`'s
 * `--close-in` handling, which this mirrors in spirit but does not import).
 */

import { strikeLadder, type MicroUsd, type Ticker } from "@meridian/sdk";
import type { PublicKey } from "@solana/web3.js";
import type { LifecycleChain, MarketAccountDecoded } from "./chain.js";
import { atTheMoneyStrike, previousCloseMicroFor } from "./prices.js";

export interface TickerDay {
  ticker: Ticker;
  prevCloseMicro: MicroUsd;
  ladder: MicroUsd[];
  atmStrike: MicroUsd;
  strikesToMarkets: Map<string, PublicKey>;
}

export interface SyntheticDay {
  tradingDay: number;
  closeTs: number;
  capacity: number;
  byTicker: Map<Ticker, TickerDay>;
}

export interface TickerLadder {
  prevCloseMicro: MicroUsd;
  ladder: MicroUsd[];
  atmStrike: MicroUsd;
}

/**
 * Pure (no RPC) per-ticker ladder derivation, shared by `createSyntheticDay`
 * (below) and `scripts/lifecycle.ts`'s preflight step (fix #8), which needs
 * the exact same ladders up front to size the admin's required rent --
 * computed once here so both call sites can never silently disagree on how
 * many markets this run is about to create.
 */
export function deriveTickerLadders(
  tickers: Ticker[],
  latestMockPrices: Map<Ticker, bigint>,
): Map<Ticker, TickerLadder> {
  const ladders = new Map<Ticker, TickerLadder>();
  for (const ticker of tickers) {
    const prevCloseMicro = previousCloseMicroFor(ticker, latestMockPrices.get(ticker));
    const ladder = strikeLadder(prevCloseMicro);
    const atmStrike = atTheMoneyStrike(prevCloseMicro);
    if (!ladder.includes(atmStrike)) {
      throw new Error(`deriveTickerLadders: ATM strike ${atmStrike} for ${ticker} is not in its own ladder`);
    }
    ladders.set(ticker, { prevCloseMicro, ladder, atmStrike });
  }
  return ladders;
}

/** Total number of markets `deriveTickerLadders`'s result will create (sum of every ticker's ladder length). */
export function totalPlannedMarkets(ladders: Map<Ticker, TickerLadder>): number {
  let total = 0;
  for (const { ladder } of ladders.values()) total += ladder.length;
  return total;
}

/** `YYYYMMDD` for a synthetic demo day: today's real trading day plus one, so it's never the real session. */
export function syntheticTradingDay(nowSeconds: number): number {
  const d = new Date(nowSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  // +1 day keeps this distinct from "today" without needing calendar.ts's trading-day math
  // (this script never imports services/automation); the program only cares that
  // `close_ts` is in the future, not that `trading_day` is a real session.
  const next = new Date(Date.UTC(y, m - 1, day + 1));
  return next.getUTCFullYear() * 10000 + (next.getUTCMonth() + 1) * 100 + next.getUTCDate();
}

/** Adds `deltaDays` to a `YYYYMMDD` integer, handling month/year rollover. */
export function addDaysToYyyymmdd(yyyymmdd: number, deltaDays: number): number {
  const year = Math.floor(yyyymmdd / 10000);
  const month = Math.floor((yyyymmdd % 10000) / 100);
  const day = yyyymmdd % 100;
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * Creates every strike's `Market` + `Book` for `tickers`, logging one
 * numbered line per market. Returns the full day's addresses for the
 * caller's report and for picking the ATM strike/market to trade on.
 */
export async function createSyntheticDay(
  chain: LifecycleChain,
  tickers: Ticker[],
  closeInSeconds: number,
  capacity: number,
  nowSeconds: number,
  latestMockPrices: Map<Ticker, bigint>,
  log: (line: string) => void,
): Promise<SyntheticDay> {
  const closeTs = nowSeconds + closeInSeconds;

  // Ladders/ATM strikes are pure (no RPC) and don't depend on which trading_day is
  // eventually chosen, so derive them all up front.
  const ladders = deriveTickerLadders(tickers, latestMockPrices);

  // Every (ticker, strike) this run is about to create, flattened once so the fresh-day
  // search below (and nothing else) needs to reason about it.
  const plannedStrikes: Array<{ ticker: Ticker; strike: MicroUsd }> = [];
  for (const [ticker, { ladder }] of ladders.entries()) {
    for (const strike of ladder) plannedStrikes.push({ ticker, strike });
  }

  // Pick a trading_day on which *none* of the planned markets already exist.
  // `trading_day` is an opaque u32 PDA seed component as far as the program is concerned
  // (`create_market.rs` validates `close_ts`/`strike`/`capacity`/`ticker`, never the date
  // itself), so any value works; this starts at "tomorrow" (`syntheticTradingDay`) and
  // advances a day at a time until a wholly fresh day is found -- needed because this
  // script can run more than once against the same long-lived validator within the same
  // calendar day (e.g. its own CLI invocation immediately followed by
  // `tests/integration/lifecycle.test.ts` calling `runLifecycle` again), which would
  // otherwise collide on `create_market`'s `init` (`AccountAlreadyInUse`).
  //
  // Fix #10: every planned ticker x strike must be checked for the candidate day, not
  // just the first ticker's first strike -- checking only one market let a day that was
  // fresh for that one probe but already occupied (by a different ticker, or a different
  // strike of the same ticker, e.g. from a reordered or widened `--tickers` list on a
  // rerun) slip through, colliding on `create_market` later for every other market on that
  // day. Fails loudly (rather than looping forever) if no fresh day turns up within 30
  // candidates.
  const MAX_DAY_SEARCH_ATTEMPTS = 30;
  let tradingDay = syntheticTradingDay(nowSeconds);
  const firstCandidate = tradingDay;
  let foundFreshDay = false;
  for (let attempt = 0; attempt < MAX_DAY_SEARCH_ATTEMPTS; attempt += 1) {
    const existing = await chain.marketsExist(
      plannedStrikes.map(({ ticker, strike }) => chain.marketAddress(ticker, tradingDay, strike)),
    );
    if (existing.every((exists) => !exists)) {
      foundFreshDay = true;
      break;
    }
    tradingDay = addDaysToYyyymmdd(tradingDay, 1);
  }
  if (!foundFreshDay) {
    throw new Error(
      `createSyntheticDay: no trading day free of every planned market (${plannedStrikes.length} ticker/strike pairs across ${tickers.join(", ")}) was found in ${MAX_DAY_SEARCH_ATTEMPTS} candidates starting at ${firstCandidate}`,
    );
  }

  const byTicker = new Map<Ticker, TickerDay>();

  for (const ticker of tickers) {
    const { prevCloseMicro, ladder, atmStrike } = ladders.get(ticker)!;
    const strikesToMarkets = new Map<string, PublicKey>();
    for (const strike of ladder) {
      const market = await chain.createMarket(ticker, strike, tradingDay, closeTs, capacity);
      log(`create_market ${ticker} strike=${strike} -> ${market.toBase58()}`);
      await chain.pace();
      await chain.createBookUntilDone(market);
      log(`create_book   ${ticker} strike=${strike} -> market ${market.toBase58()} book ready`);
      strikesToMarkets.set(strike.toString(), market);
    }

    byTicker.set(ticker, { ticker, prevCloseMicro, ladder, atmStrike, strikesToMarkets });
  }

  return { tradingDay, closeTs, capacity, byTicker };
}

/** Fetches the decoded `Market` for `ticker`'s ATM strike (must already exist). */
export async function fetchAtmMarket(
  chain: LifecycleChain,
  day: SyntheticDay,
  ticker: Ticker,
): Promise<{ marketAddress: PublicKey; market: MarketAccountDecoded }> {
  const tickerDay = day.byTicker.get(ticker);
  if (!tickerDay) throw new Error(`fetchAtmMarket: no day data for ${ticker}`);
  const marketAddress = tickerDay.strikesToMarkets.get(tickerDay.atmStrike.toString());
  if (!marketAddress) throw new Error(`fetchAtmMarket: no market for ${ticker} ATM strike ${tickerDay.atmStrike}`);
  const market = await chain.fetchMarket(marketAddress);
  if (!market) throw new Error(`fetchAtmMarket: market ${marketAddress.toBase58()} does not exist on chain`);
  return { marketAddress, market };
}
