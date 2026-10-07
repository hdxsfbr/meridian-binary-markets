/**
 * Reconstructs per-market positions and realized P&L for one wallet from the
 * Meridian event stream (`events.ts`; data-model.md "Position and P&L
 * (web, derived)"; research.md R11). No database, no custodial state: this
 * is a pure fold over `MeridianEvent[]`, safe to re-run from genesis any
 * time the cached event list grows.
 *
 * ## The average-cost method
 *
 * Yes and No are tracked as two independent fungible positions, each with
 * its own running (cost, quantity) pair. The average cost per unit of a leg
 * is always `cost / qty`; every acquisition updates `cost`/`qty` directly,
 * and every disposal removes cost *proportionally* -- `costRemoved = cost *
 * disposedQty / qtyBeforeDisposal` (bigint floor division; a model with
 * these two legs mintable only as a pair, and traded in whole-unit lots on
 * the money path, never ends up needing the remainder) -- so the average
 * cost of whatever remains is unchanged. Realized P&L on a disposal is
 * `proceeds - costRemoved`.
 *
 * `mint_pair(qty)` (`Minted`) transfers `qty * 1_000_000` micro-USDC for
 * `qty` Yes *and* `qty` No (data-model.md): one pair, one dollar, no
 * observed market price to split it by. This module books that dollar
 * 50/50 across the two legs (`500_000` micro-USDC per unit per leg), which
 * is exactly the data-model.md rule "No entry price = `1_000_000 -
 * yes_fill_price`" applied at the only price a mint ever implies: the
 * neutral midpoint, `yes_fill_price = 500_000`.
 *
 * `redeem_pair(qty)` (`PairRedeemed`) burns `qty` Yes and `qty` No for
 * `qty * 1_000_000` micro-USDC back. Unlike mint's fixed 50/50 split, this
 * removes each leg's cost *proportionally*, at whatever that leg's average
 * cost is *now* -- which can have drifted away from the 500_000 mint price
 * if a `Fill` traded that leg (or the complementary Yes trade that a held
 * No leg's value depends on) in between. The pair's realized P&L is
 * `qty * 1_000_000 - (costYesRemoved + costNoRemoved)`: e.g. mint 1 pair,
 * sell Yes @0.65 (realize +0.15, Yes leg now cost 0), buy Yes back @0.40
 * (Yes leg now cost 400_000), then redeem the pair -- the No leg still
 * costs 500_000, so redeeming realizes `1_000_000 - (400_000 + 500_000) =
 * 100_000` on top of the sell's +150_000, for +250_000 total and a final
 * basis of 0 -- not a flat reversal of the mint's own 500_000/500_000 split.
 *
 * `Fill` only ever moves the Yes leg: the order book (`book.ts`) is
 * Yes-denominated only ("bids are Yes buyers, asks are Yes sellers"), so
 * there is no on-chain event for a direct No trade. Establishing or
 * unwinding a No-heavy position by selling/buying back Yes is, from this
 * module's point of view, an ordinary Yes disposal/acquisition against the
 * Yes leg's own average cost -- the No leg is untouched by a `Fill`. The
 * data-model.md No-entry-price rule is already fully realized by the fixed
 * 50/50 mint split above; this module does not additionally re-price a held
 * No token when its complementary Yes is later sold, since no event
 * attributes a price to the No leg itself. A self-fill (the wallet is both
 * maker and taker of the same `Fill`) changes nothing: the wallet traded
 * with itself at one price for one quantity, so the buy and sell sides net
 * to exactly zero change in holdings, cost, and realized P&L.
 *
 * `Settled(outcome)` writes off the *losing* leg's entire remaining cost
 * basis as a realized loss, once, the moment settlement is observed --
 * holding a losing token is already worth 1_000_000 - 1_000_000 = 0, and
 * nothing else will ever move its cost basis (there is no `Fill` for it,
 * and `WinningRedeemed` only ever pays the winning side), so deferring the
 * loss until (never) redeemed would permanently overstate the position's
 * basis. The *quantity* of losing tokens is left untouched (they still
 * exist until burned, if ever) -- only their cost, and only exactly once
 * per market (guarded by `settled` already being set).
 *
 * `WinningRedeemed(side, qty, payout)` disposes of `qty` units of whichever
 * leg `side` names, at its current average cost, crediting `realized +=
 * payout - costRemoved` (payout is already `qty * 1_000_000` micro-USDC,
 * computed on chain). Since `Settled` already zeroed the losing leg's
 * cost, redeeming the *winning* side here removes cost that was never
 * written off, so this does not double-count the `Settled` write-off.
 */

import type { PublicKey } from "@solana/web3.js";
import { ONE_USDC, Side } from "#types";
import type { MeridianEvent } from "#events";

/** A wallet's reconstructed holding in one market. */
export type Position = {
  market: PublicKey;
  /** Yes tokens currently held, base units (6 decimals, whole tokens). */
  yes: bigint;
  /** No tokens currently held, base units. */
  no: bigint;
  /** Net pairs minted and not yet redeemed via `redeem_pair` (FR-006/034 bookkeeping only). */
  mintedPairs: bigint;
  /** Combined (Yes leg + No leg) average-cost basis of currently held tokens, micro-USDC. */
  costBasisMicro: bigint;
  /** Cumulative realized P&L from sells, winning redemptions, micro-USDC (may be negative). */
  realizedPnlMicro: bigint;
  /** Present once a `Settled` event for this market has been observed. */
  settled?: {
    price: bigint;
    outcome: 1 | 2;
    /** Cumulative payout actually received via `WinningRedeemed` for this market, micro-USDC. */
    payoutMicro: bigint;
  };
};

/** Internal per-leg state; `Position.costBasisMicro` is `costYes + costNo`. */
type MutablePosition = {
  market: PublicKey;
  yes: bigint;
  no: bigint;
  mintedPairs: bigint;
  costYes: bigint;
  costNo: bigint;
  realized: bigint;
  settled?: Position["settled"];
};

const HALF_USDC = ONE_USDC / 2n;

function toPosition(p: MutablePosition): Position {
  return {
    market: p.market,
    yes: p.yes,
    no: p.no,
    mintedPairs: p.mintedPairs,
    costBasisMicro: p.costYes + p.costNo,
    realizedPnlMicro: p.realized,
    settled: p.settled,
  };
}

/** `cost * removedQty / qtyBefore`, bigint floor division; 0 when `qtyBefore` is 0. */
function proportionalCost(cost: bigint, qtyBefore: bigint, removedQty: bigint): bigint {
  if (qtyBefore === 0n) {
    return 0n;
  }
  return (cost * removedQty) / qtyBefore;
}

function getOrCreate(positions: Map<string, MutablePosition>, market: PublicKey): MutablePosition {
  const key = market.toBase58();
  let pos = positions.get(key);
  if (pos === undefined) {
    pos = { market, yes: 0n, no: 0n, mintedPairs: 0n, costYes: 0n, costNo: 0n, realized: 0n };
    positions.set(key, pos);
  }
  return pos;
}

/**
 * Folds `events` (any order of markets, but must be chronological per
 * market -- as `parseEventsFromLogs`/`fetchWalletEvents` already return
 * them) into one `Position` per market touched by `wallet`, keyed by the
 * market's base58 address.
 */
export function buildPositions(events: readonly MeridianEvent[], wallet: PublicKey): Map<string, Position> {
  const positions = new Map<string, MutablePosition>();

  for (const event of events) {
    switch (event.name) {
      case "Minted": {
        if (!event.data.user.equals(wallet)) {
          break;
        }
        const pos = getOrCreate(positions, event.data.market);
        const qty = event.data.qty;
        pos.yes += qty;
        pos.no += qty;
        pos.mintedPairs += qty;
        pos.costYes += qty * HALF_USDC;
        pos.costNo += qty * HALF_USDC;
        break;
      }
      case "PairRedeemed": {
        if (!event.data.user.equals(wallet)) {
          break;
        }
        const pos = getOrCreate(positions, event.data.market);
        const qty = event.data.qty;
        const costYesRemoved = proportionalCost(pos.costYes, pos.yes, qty);
        const costNoRemoved = proportionalCost(pos.costNo, pos.no, qty);
        pos.yes -= qty;
        pos.no -= qty;
        pos.mintedPairs -= qty;
        pos.costYes -= costYesRemoved;
        pos.costNo -= costNoRemoved;
        pos.realized += qty * ONE_USDC - (costYesRemoved + costNoRemoved);
        break;
      }
      case "Fill": {
        const isTaker = event.data.taker.equals(wallet);
        const isMaker = event.data.maker.equals(wallet);
        if (!isTaker && !isMaker) {
          break;
        }
        if (isTaker && isMaker) {
          // Self-fill: the wallet is on both sides of the same trade, so
          // the buy and sell net to exactly zero.
          break;
        }
        // The maker's resting order is always the opposite side of the taker's,
        // since a fill is exactly one buyer matched against one seller.
        const walletAction = isTaker
          ? event.data.sideOfTaker
          : event.data.sideOfTaker === Side.Bid
            ? Side.Ask
            : Side.Bid;
        const pos = getOrCreate(positions, event.data.market);
        const { price, qty } = event.data;
        if (walletAction === Side.Bid) {
          // Buying Yes.
          pos.yes += qty;
          pos.costYes += price * qty;
        } else {
          // Selling Yes.
          const costRemoved = proportionalCost(pos.costYes, pos.yes, qty);
          pos.realized += price * qty - costRemoved;
          pos.costYes -= costRemoved;
          pos.yes -= qty;
        }
        break;
      }
      case "Settled": {
        const key = event.data.market.toBase58();
        const pos = positions.get(key);
        if (pos === undefined) {
          break;
        }
        if (pos.settled === undefined) {
          // First (and only) time this market settles for this wallet:
          // write off the losing leg's entire remaining basis as a
          // realized loss. The quantity itself is left alone.
          if (event.data.outcome === 1) {
            pos.realized -= pos.costNo;
            pos.costNo = 0n;
          } else {
            pos.realized -= pos.costYes;
            pos.costYes = 0n;
          }
        }
        pos.settled = {
          price: event.data.price,
          outcome: event.data.outcome,
          payoutMicro: pos.settled?.payoutMicro ?? 0n,
        };
        break;
      }
      case "WinningRedeemed": {
        if (!event.data.user.equals(wallet)) {
          break;
        }
        const pos = getOrCreate(positions, event.data.market);
        const { side, qty, payout } = event.data;
        if (side === 1) {
          const costRemoved = proportionalCost(pos.costYes, pos.yes, qty);
          pos.costYes -= costRemoved;
          pos.yes -= qty;
          pos.realized += payout - costRemoved;
        } else {
          const costRemoved = proportionalCost(pos.costNo, pos.no, qty);
          pos.costNo -= costRemoved;
          pos.no -= qty;
          pos.realized += payout - costRemoved;
        }
        pos.settled = {
          price: pos.settled?.price ?? 0n,
          outcome: side,
          payoutMicro: (pos.settled?.payoutMicro ?? 0n) + payout,
        };
        break;
      }
      case "MarketCreated":
      case "OrderPlaced":
      case "OrderCancelled":
      case "Paused":
      case "Unpaused":
        // No position effect: these don't move tokens or cash for `wallet`.
        break;
    }
  }

  const out = new Map<string, Position>();
  for (const [key, pos] of positions) {
    out.set(key, toPosition(pos));
  }
  return out;
}

/** Totals across every market in `positions`. */
export type PositionSummary = {
  yes: bigint;
  no: bigint;
  mintedPairs: bigint;
  costBasisMicro: bigint;
  realizedPnlMicro: bigint;
};

/** Sums every field of every `Position` in `positions`. */
export function summarize(positions: Map<string, Position> | Iterable<Position>): PositionSummary {
  const values = positions instanceof Map ? positions.values() : positions;
  const total: PositionSummary = {
    yes: 0n,
    no: 0n,
    mintedPairs: 0n,
    costBasisMicro: 0n,
    realizedPnlMicro: 0n,
  };
  for (const p of values) {
    total.yes += p.yes;
    total.no += p.no;
    total.mintedPairs += p.mintedPairs;
    total.costBasisMicro += p.costBasisMicro;
    total.realizedPnlMicro += p.realizedPnlMicro;
  }
  return total;
}
