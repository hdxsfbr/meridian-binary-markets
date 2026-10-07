/**
 * Strike ladder derivation (PRD §3.3, spec.md FR-002/FR-003, User Story 2).
 *
 * Each morning the automation service derives a strike ladder for a stock
 * from its previous close: the rounded close itself, plus six strikes at
 * ±3%, ±6% and ±9%, rounded to the nearest $10 and deduplicated. Everything
 * here is `bigint` micro-USD (6 decimals, `MicroUsd` in `./types`) — no
 * floating point anywhere on this path (FR-008).
 *
 * Rounding order matters and is fixed by FR-002: for each offset we first
 * multiply the previous close by the percentage factor (97/94/91 for the
 * three "below" offsets, 103/106/109 for the three "above" offsets) and
 * integer-divide by 100, discarding any remainder from that division. Only
 * *after* that truncating division do we apply `round10` to snap the result
 * to the nearest $10. Rounding before dividing would shift results for
 * some inputs; this file always divides first, then rounds.
 */

import type { MicroUsd } from "#types";

/** $10 in micro-USD: the ladder's rounding unit. */
const TEN_DOLLARS_MICRO = 10_000_000n;

/** Half of `TEN_DOLLARS_MICRO`; a remainder exactly at this value rounds up. */
const HALF_TEN_DOLLARS_MICRO = TEN_DOLLARS_MICRO / 2n;

/**
 * The three strike offsets from the previous close, in basis points.
 * 300 bps = 3%, 600 bps = 6%, 900 bps = 9%, applied both above and below.
 */
export const STRIKE_OFFSETS_BPS: readonly number[] = [300, 600, 900];

/**
 * Rounds `micro` (micro-USD) to the nearest multiple of `TEN_DOLLARS_MICRO`
 * ($10), with an exact half rounding up (towards +infinity). E.g. $685.00
 * rounds up to $690; $684.99 rounds down to $680.
 */
export function round10(micro: bigint): bigint {
  if (typeof micro !== "bigint") {
    throw new Error(`round10: expected a bigint, got ${typeof micro}`);
  }

  // Normalize the remainder into [0, TEN_DOLLARS_MICRO) regardless of the
  // sign of `micro` (bigint `%` can return a negative remainder for a
  // negative dividend).
  const remainder = ((micro % TEN_DOLLARS_MICRO) + TEN_DOLLARS_MICRO) % TEN_DOLLARS_MICRO;
  const base = micro - remainder;
  return remainder >= HALF_TEN_DOLLARS_MICRO ? base + TEN_DOLLARS_MICRO : base;
}

/**
 * Derives the strike ladder for a stock from its previous close, per
 * PRD §3.3: the rounded close plus ±3%/±6%/±9%, each rounded to the nearest
 * $10 (divide-then-round, see module doc), deduplicated, sorted ascending,
 * with any non-positive candidate excluded.
 *
 * `prevCloseMicro` must be a positive bigint (micro-USD); throws otherwise.
 */
export function strikeLadder(prevCloseMicro: bigint): MicroUsd[] {
  if (typeof prevCloseMicro !== "bigint" || prevCloseMicro <= 0n) {
    throw new Error(
      `strikeLadder: prevCloseMicro must be a positive bigint, got ${String(prevCloseMicro)}`,
    );
  }

  const candidates: bigint[] = [round10(prevCloseMicro)];

  for (const bps of STRIKE_OFFSETS_BPS) {
    // STRIKE_OFFSETS_BPS is always a multiple of 100, so this is an exact
    // whole-percent integer (3, 6, 9) with no rounding.
    const pct = BigInt(bps) / 100n;
    const belowFactor = 100n - pct; // 97, 94, 91
    const aboveFactor = 100n + pct; // 103, 106, 109

    // Multiply, then integer-divide by 100 (truncating), then round to the
    // nearest $10 — in that order, per the module doc.
    candidates.push(round10((prevCloseMicro * belowFactor) / 100n));
    candidates.push(round10((prevCloseMicro * aboveFactor) / 100n));
  }

  const unique = Array.from(new Set(candidates.filter((v) => v > 0n)));
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique as MicroUsd[];
}
