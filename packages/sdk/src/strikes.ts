/**
 * Strike ladder derivation (PRD §3.3, spec.md FR-002/FR-003, User Story 2;
 * grid-by-magnitude rule added DECISIONS.md §30 for BTC).
 *
 * Each morning the automation service derives a strike ladder for a ticker
 * from its previous close: the rounded close itself, plus six strikes at
 * ±3%, ±6% and ±9%, rounded to the nearest grid step and deduplicated.
 * Everything here is `bigint` micro-USD (6 decimals, `MicroUsd` in
 * `./types`) — no floating point anywhere on this path (FR-008).
 *
 * The grid step depends on the previous close's magnitude (`strikeStepFor`):
 * $10 under $5,000, $100 under $50,000, $500 at or above $50,000. Every
 * equity ticker in `TICKERS`/`FEED_IDS` trades well under $5,000, so this is
 * a no-op $10 grid for them; it exists so a ~$100k asset like BTC gets
 * strikes on a $500 grid (e.g. 97,000 / 100,000 / 103,000 / ...) instead of
 * 601 candidate strikes $10 apart.
 *
 * Rounding order matters and is fixed by FR-002: for each offset we first
 * multiply the previous close by the percentage factor (97/94/91 for the
 * three "below" offsets, 103/106/109 for the three "above" offsets) and
 * integer-divide by 100, discarding any remainder from that division. Only
 * *after* that truncating division do we apply `round10` to snap the result
 * to the nearest grid step. Rounding before dividing would shift results
 * for some inputs; this file always divides first, then rounds.
 */

import type { MicroUsd } from "#types";

/** $10 in micro-USD: the ladder's rounding unit for prices under $5,000. */
const TEN_DOLLARS_MICRO = 10_000_000n;

/** $100 in micro-USD: the rounding unit for prices from $5,000 up to $50,000. */
const HUNDRED_DOLLARS_MICRO = 100_000_000n;

/** $500 in micro-USD: the rounding unit for prices at or above $50,000. */
const FIVE_HUNDRED_DOLLARS_MICRO = 500_000_000n;

/** $5,000 in micro-USD: below this, the grid step is `TEN_DOLLARS_MICRO`. */
const FIVE_THOUSAND_DOLLARS_MICRO = 5_000_000_000n;

/** $50,000 in micro-USD: at or above this, the grid step is `FIVE_HUNDRED_DOLLARS_MICRO`. */
const FIFTY_THOUSAND_DOLLARS_MICRO = 50_000_000_000n;

/**
 * The three strike offsets from the previous close, in basis points.
 * 300 bps = 3%, 600 bps = 6%, 900 bps = 9%, applied both above and below.
 */
export const STRIKE_OFFSETS_BPS: readonly number[] = [300, 600, 900];

/**
 * The strike grid's rounding step (micro-USD) for a price of this
 * magnitude (DECISIONS.md §30): $10 under $5,000, $100 under $50,000, $500
 * at or above $50,000. Shared by `strikeLadder` (below), the `extend` job's
 * intraday ladder extension (`services/automation/src/jobs/extend.ts`), and
 * any UI "nearest strike" helper, so every path snaps to the same grid for
 * a given price.
 */
export function strikeStepFor(priceMicro: bigint): bigint {
  if (typeof priceMicro !== "bigint") {
    throw new Error(`strikeStepFor: expected a bigint, got ${typeof priceMicro}`);
  }
  if (priceMicro < FIVE_THOUSAND_DOLLARS_MICRO) return TEN_DOLLARS_MICRO;
  if (priceMicro < FIFTY_THOUSAND_DOLLARS_MICRO) return HUNDRED_DOLLARS_MICRO;
  return FIVE_HUNDRED_DOLLARS_MICRO;
}

/**
 * Rounds `micro` (micro-USD) to the nearest multiple of `step` (micro-USD;
 * defaults to `TEN_DOLLARS_MICRO`, i.e. the nearest $10, for callers that
 * don't pass one), with an exact half rounding up (towards +infinity). E.g.
 * with the default step, $685.00 rounds up to $690; $684.99 rounds down to
 * $680. Pass `strikeStepFor(price)` to round on the magnitude-appropriate
 * grid instead.
 */
export function round10(micro: bigint, step: bigint = TEN_DOLLARS_MICRO): bigint {
  if (typeof micro !== "bigint") {
    throw new Error(`round10: expected a bigint, got ${typeof micro}`);
  }
  if (typeof step !== "bigint" || step <= 0n) {
    throw new Error(`round10: step must be a positive bigint, got ${String(step)}`);
  }

  // Normalize the remainder into [0, step) regardless of the sign of
  // `micro` (bigint `%` can return a negative remainder for a negative
  // dividend).
  const remainder = ((micro % step) + step) % step;
  const base = micro - remainder;
  return remainder * 2n >= step ? base + step : base;
}

/**
 * Derives the strike ladder for a ticker from its previous close, per
 * PRD §3.3: the rounded close plus ±3%/±6%/±9%, each rounded to the nearest
 * grid step (`strikeStepFor(prevCloseMicro)`, divide-then-round per the
 * module doc), deduplicated, sorted ascending, with any non-positive
 * candidate excluded.
 *
 * `prevCloseMicro` must be a positive bigint (micro-USD); throws otherwise.
 */
export function strikeLadder(prevCloseMicro: bigint): MicroUsd[] {
  if (typeof prevCloseMicro !== "bigint" || prevCloseMicro <= 0n) {
    throw new Error(
      `strikeLadder: prevCloseMicro must be a positive bigint, got ${String(prevCloseMicro)}`,
    );
  }

  const step = strikeStepFor(prevCloseMicro);
  const candidates: bigint[] = [round10(prevCloseMicro, step)];

  for (const bps of STRIKE_OFFSETS_BPS) {
    // STRIKE_OFFSETS_BPS is always a multiple of 100, so this is an exact
    // whole-percent integer (3, 6, 9) with no rounding.
    const pct = BigInt(bps) / 100n;
    const belowFactor = 100n - pct; // 97, 94, 91
    const aboveFactor = 100n + pct; // 103, 106, 109

    // Multiply, then integer-divide by 100 (truncating), then round to the
    // nearest grid step — in that order, per the module doc.
    candidates.push(round10((prevCloseMicro * belowFactor) / 100n, step));
    candidates.push(round10((prevCloseMicro * aboveFactor) / 100n, step));
  }

  const unique = Array.from(new Set(candidates.filter((v) => v > 0n)));
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique as MicroUsd[];
}
