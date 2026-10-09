/**
 * Turns the confirmed events of one trade-panel transaction into the
 * numbers its toast actually reports (review item: the toast must describe
 * what executed, not the pre-send estimate -- a market order's `matchedQty`
 * preview and `plan.estimate.cost` are both computed against a book
 * snapshot taken *before* sending, and the confirmed transaction can
 * execute less, or nothing at all, than that snapshot predicted).
 *
 * `computeTradeResult` is pure and deterministic given the decoded events
 * of exactly one transaction (`TradePanel.tsx` sends exactly one
 * instruction per click, so there is exactly one order to attribute these
 * events to): it never reaches for a transaction signature, an RPC/program
 * term, or anything the caller didn't already have on hand. `tradeResultToast`
 * then turns that result into the toast's title/detail/tone using the same
 * copy helpers (`trade-copy.ts`) the panel's own inline estimate uses.
 *
 * - Executed quantity/amount comes entirely from `Fill` events where this
 *   transaction's `market`/`user` are the taker -- `Fill.sideOfTaker` is
 *   constant across every such event here (one order per transaction), so
 *   summing by market+taker alone is enough; no other event name needs to
 *   be inspected to know what actually traded.
 * - A resting remainder (limit paths only) comes from this transaction's
 *   `OrderPlaced` event for the same market/user, whose `qty` is always the
 *   *full requested* quantity (the program emits it unconditionally, even
 *   for an IOC that fills completely or finds nothing -- see
 *   `programs/meridian/src/instructions/place_order.rs`): subtracting the
 *   executed quantity above gives what's actually still open. A market
 *   path through `buy_no_market`/`sell_no_market` never emits `OrderPlaced`
 *   at all (those instructions never rest anything), so `open` is simply
 *   never present for them -- no `kind`/`ix` flag needs to be threaded in
 *   to know that.
 * - Any other market's or wallet's events in the same batch (a maker's
 *   `Fill`, another order's `OrderPlaced`) are filtered out by the same
 *   market+taker/owner check and never affect the result.
 */

import { PublicKey } from "@solana/web3.js";
import { ONE_USDC, type Action, type MeridianEvent } from "@meridian/sdk";
import type { ToastTone } from "@/components/ui/Toast";
import { limitOrderToastDetail, limitOrderToastTitle, marketOrderToastTitle, NOTHING_TRADED, stillOpenFragment } from "./trade-copy";

export type TradeResult = {
  /** Total quantity this transaction actually matched, for `market`+`user` as taker. */
  executedQty: bigint;
  /** Unsigned total: `Σ(price × qty)` for a Yes action, `Σ((ONE_USDC − price) × qty)` for a No action. */
  amountMicro: bigint;
  /** The resting remainder left open by this transaction (limit paths only) -- absent whenever nothing is still open. */
  open?: { qty: bigint; priceMicro: bigint };
};

const NO_ACTIONS: ReadonlySet<Action> = new Set(["buyNo", "sellNo"]);

/**
 * Computes what one transaction's events actually executed for `market`/
 * `user`/`action`. See module doc for exactly which events (and fields)
 * this reads and why that's sufficient.
 */
export function computeTradeResult(
  events: readonly MeridianEvent[],
  market: PublicKey,
  user: PublicKey,
  action: Action,
): TradeResult {
  const isNo = NO_ACTIONS.has(action);

  let executedQty = 0n;
  let amountMicro = 0n;
  for (const event of events) {
    if (event.name !== "Fill") {
      continue;
    }
    const data = event.data;
    if (!data.market.equals(market) || !data.taker.equals(user)) {
      continue;
    }
    executedQty += data.qty;
    amountMicro += isNo ? (ONE_USDC - data.price) * data.qty : data.price * data.qty;
  }

  let open: { qty: bigint; priceMicro: bigint } | undefined;
  for (const event of events) {
    if (event.name !== "OrderPlaced") {
      continue;
    }
    const data = event.data;
    if (!data.market.equals(market) || !data.owner.equals(user)) {
      continue;
    }
    const remaining = data.qty - executedQty;
    if (remaining > 0n) {
      open = { qty: remaining, priceMicro: data.price };
    }
    // Exactly one order is ever placed per transaction here (TradePanel
    // sends one instruction per click); the first match is the only match.
    break;
  }

  return { executedQty, amountMicro, open };
}

/**
 * Turns a `TradeResult` into the toast copy: a confirmed trade ("Bought 2
 * Yes on AAPL $345 for $1.10"), a confirmed trade with a remainder still
 * open ("...; 1 Yes still open at $0.55"), a limit order left fully open
 * ("Order open: ..." + "Reserved $... until it trades"), or -- a market
 * path that executed nothing at all -- an explicit, non-alarming
 * acknowledgement rather than repeating the word "Bought" for zero
 * contracts.
 */
export function tradeResultToast(
  result: TradeResult,
  action: Action,
  ticker: string,
  strikeMicro: bigint,
): { title: string; detail?: string; tone: ToastTone } {
  const { executedQty, amountMicro, open } = result;

  if (executedQty === 0n && open === undefined) {
    return { title: NOTHING_TRADED, tone: "info" };
  }

  if (open !== undefined) {
    if (executedQty > 0n) {
      return {
        title: `${marketOrderToastTitle(action, ticker, strikeMicro, executedQty, amountMicro)}; ${stillOpenFragment(action, open.qty, open.priceMicro)}`,
        tone: "success",
      };
    }
    const reserveMicro = open.qty * open.priceMicro;
    return {
      title: limitOrderToastTitle(action, ticker, strikeMicro, open.qty, open.priceMicro),
      detail: limitOrderToastDetail(action, reserveMicro, open.qty),
      tone: "success",
    };
  }

  return { title: marketOrderToastTitle(action, ticker, strikeMicro, executedQty, amountMicro), tone: "success" };
}
