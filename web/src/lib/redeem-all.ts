/**
 * Pure planning + chunking for "Redeem all" (REVAMP_PLAN Wave R4, the
 * "Redeem all" decision dated 2026-10-08): collects every settled winning
 * balance and every held pair across a wallet's positions into one flat
 * list of redeem actions, then groups that list into as few transactions as
 * fit under the program's per-transaction instruction cap.
 *
 * No React, no RPC here -- the Portfolio page and the nav pill wire this to
 * the chain by mapping each `RedeemPlanItem` through `redeem-tx.ts`'s
 * instruction builders and sending each chunk as one transaction via
 * `tx.ts`'s `sendTx`.
 */

import { ONE_USDC } from "@meridian/sdk";
import type { PositionRowData } from "./positions-view";

export type RedeemPlanItem =
  | { kind: "winning"; marketKey: string; side: "yes" | "no"; qty: bigint }
  | { kind: "pair"; marketKey: string; qty: bigint };

/**
 * Every redeemable action across `rows`: one `"winning"` item per settled
 * market the wallet holds a payout on (FR-022), and one `"pair"` item per
 * market where it still holds a matched pair, open or settled (FR-006/034).
 * Order follows `rows`' own order (open before settled, then close time,
 * ticker, strike -- `positions-view.ts`'s `sortRows`).
 */
export function planRedeemAll(rows: readonly PositionRowData[]): RedeemPlanItem[] {
  const plan: RedeemPlanItem[] = [];
  for (const row of rows) {
    // A row's `yes`/`no` balances already include whatever is matched into
    // `pairsHeld` -- e.g. settled Yes won, yes=3, no=1: 1 pair is held
    // *and* 3 Yes are held, but only 2 of those 3 Yes are left over once
    // the pair is redeemed. Plan the pair first, then the winning side's
    // *remaining* balance after that pair is gone, so the two instructions
    // never both reach for the same tokens -- the wallet would not hold
    // enough to cover both at execution time otherwise.
    const pairs = row.canRedeemPair && row.pairsHeld > 0n ? row.pairsHeld : 0n;
    if (pairs > 0n) {
      plan.push({ kind: "pair", marketKey: row.marketKey, qty: pairs });
    }
    if (row.canRedeemWinning && row.winningSide !== undefined) {
      const held = row.winningSide === "yes" ? row.yes : row.no;
      const remaining = held - pairs;
      if (remaining > 0n) {
        plan.push({ kind: "winning", marketKey: row.marketKey, side: row.winningSide, qty: remaining });
      }
    }
  }
  return plan;
}

/**
 * Total micro-USDC `planRedeemAll`'s items would actually pay out right
 * now: `$1` per planned pair plus `$1` per planned winning token, summed
 * across the corrected plan (never `row.payoutAvailableMicro` directly --
 * that figure double-counts tokens already spoken for by a pair
 * redemption on the same row). Used by the Portfolio banner and the nav
 * pill ("You have $X to collect") -- both should agree on the same number,
 * and that number should match what "Redeem all" actually collects.
 */
export function redeemableMicro(rows: readonly PositionRowData[]): bigint {
  let total = 0n;
  for (const item of planRedeemAll(rows)) {
    total += item.qty * ONE_USDC;
  }
  return total;
}

/**
 * Splits `items` into groups of at most `size`, preserving order. Used to
 * keep each "Redeem all" transaction under the program's per-transaction
 * instruction/size limit (`REDEEM_ALL_CHUNK_SIZE` below). `size <= 0`
 * degenerates to one item per chunk rather than looping forever.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  if (size <= 0) {
    return items.map((item) => [item]);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Instructions per "Redeem all" transaction. Measured: four `redeem_pair`
 * instructions across distinct markets serialise to 1,218 bytes, too close
 * to Solana's 1,232-byte transaction limit once a real wallet's signature
 * and a priority-fee instruction are added on top -- three per chunk
 * leaves enough headroom.
 */
export const REDEEM_ALL_CHUNK_SIZE = 3;
