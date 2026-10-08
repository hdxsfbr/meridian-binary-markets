/**
 * Pure price-table helpers for `scripts/lifecycle.ts` (tasks.md T086).
 *
 * The lifecycle script needs a "previous close" per ticker to derive a
 * strike ladder (`@meridian/sdk`'s `strikeLadder`) for its synthetic trading
 * day. The real `morning` job (`services/automation/src/jobs/morning.ts`)
 * gets this from a live `PriceProvider`; this script is deliberately
 * provider-free (no Finnhub/Nasdaq keys needed to run a demo day), so it
 * uses the latest on-chain mock price for the ticker if one already exists
 * (a previous lifecycle run, or a `morning` job that already ran against
 * this validator), falling back to a fixed table otherwise.
 */

import type { MicroUsd, Ticker } from "@meridian/sdk";
import { round10, TICKERS } from "@meridian/sdk";

/** $1 in micro-USD. */
const ONE_DOLLAR_MICRO = 1_000_000n;

/**
 * Fixed fallback previous-close table (whole USD), used when no on-chain
 * mock price exists yet for a ticker. Wave 6 brief's fixed table.
 */
export const DEFAULT_PREV_CLOSE_USD: Record<Ticker, number> = {
  AAPL: 333,
  MSFT: 525,
  GOOGL: 346,
  AMZN: 251,
  NVDA: 239,
  META: 742,
  TSLA: 379,
  QQQ: 752,
  VOO: 712,
  SPY: 650,
};

/** This script's default ticker set and order: the SDK's listed default (`TICKERS`). */
export const DEFAULT_TICKER_ORDER: readonly Ticker[] = TICKERS;

/**
 * Resolves `ticker`'s previous close (micro-USD): `latestMockPriceMicro` if
 * given (a live `MockPriceUpdate` already on chain for this ticker's feed),
 * else the fixed fallback table above.
 */
export function previousCloseMicroFor(ticker: Ticker, latestMockPriceMicro?: bigint): MicroUsd {
  if (latestMockPriceMicro !== undefined) {
    if (latestMockPriceMicro <= 0n) {
      throw new Error(`previousCloseMicroFor: latestMockPriceMicro must be positive, got ${latestMockPriceMicro}`);
    }
    return latestMockPriceMicro as MicroUsd;
  }
  const usd = DEFAULT_PREV_CLOSE_USD[ticker];
  if (usd === undefined) {
    throw new Error(`previousCloseMicroFor: no fallback previous close for ticker "${ticker}"`);
  }
  return (BigInt(usd) * ONE_DOLLAR_MICRO) as MicroUsd;
}

/**
 * The at-the-money strike for a previous close: `round10(prevCloseMicro)`,
 * the same value `strikeLadder`'s first candidate derives (PRD §3.3). A
 * caller that already has the ladder should still assert this value is a
 * member of it (data integrity, not a second derivation path).
 */
export function atTheMoneyStrike(prevCloseMicro: bigint): MicroUsd {
  return round10(prevCloseMicro) as MicroUsd;
}

/** `$5` in micro-USD, used for the demo's "price = strike + $5, so Yes wins" publish step. */
export const FIVE_DOLLARS_MICRO = 5_000_000n;

/** `$0.01` in micro-USD -- the demo publish step's fixed confidence. */
export const ONE_CENT_MICRO = 10_000n;
