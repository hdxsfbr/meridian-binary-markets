/**
 * Every user-facing string the trade panel shows, in one place
 * (contracts/frontend.md, global rule: UI copy is for the end user, never
 * implementation commentary — no provider names, "mock"/"simulated"
 * asides, or raw program error codes). `trade-copy.test.ts` asserts none of
 * these strings (or the values the formatting functions produce) contain a
 * forbidden word.
 */

import type { Action, GuidanceErrorCode } from "@meridian/sdk";
import { formatUsd } from "./format";

export const CONNECT_WALLET = "Connect a wallet to trade.";
export const TRADING_PAUSED = "Trading is paused";
export const SETTLEMENT_PENDING = "Settlement pending";
export const CHECKING_POSITION = "Checking your position…";
export const MINTED_PAIR = "Minted pair";
export const NO_HELD_YES_RESTING = "You hold No. Your Buy No order is still open.";
export const REDEEM_IN_PORTFOLIO = "Redeem in Portfolio";
export const CLOSE_NO_FIRST = "Close your No position first";
export const CLOSE_YES_FIRST = "Close your Yes position first";
export const NO_LIQUIDITY = "Not enough liquidity at that price";
export const INVALID_INPUT = "Enter a valid quantity and price";
export const ORDER_COULD_NOT_BE_PLACED = "Order could not be placed";
export const SELF_MATCH = "This would match your own open order. Cancel it first.";
export const NO_YES_TO_SELL = "You don't hold any Yes to sell";
export const NO_NO_TO_SELL = "You don't hold any No to sell";
export const HOLDINGS_LABEL = "You hold";
export const BOOK_FULL = "The order book is full right now";
export const MARKET_SETTLED = "This contract has settled";
export const MARKET_CLOSED = "This contract has closed and is waiting for settlement";
export const WOULD_CROSS = "That price would trade immediately. Use a market order instead.";
export const SIGNING_CANCELLED = "Signing was cancelled in your wallet.";
export const SENDING = "Sending…";
export const CANCEL = "Cancel";
export const CANCELLING = "Cancelling…";

/** Four trade-panel action buttons (contracts/frontend.md "Trade panel rules"). */
export const ACTION_LABEL: Record<Action, string> = {
  buyYes: "Buy Yes",
  buyNo: "Buy No",
  sellYes: "Sell Yes",
  sellNo: "Sell No",
};

export const KIND_LABEL = {
  market: "Market",
  limit: "Limit",
} as const;

/** Copy for a client-side gating/validation refusal from `toInstructionPlan` (never a raw program error). */
export function guidanceCopy(code: GuidanceErrorCode): string {
  switch (code) {
    case "closeNoFirst":
      return CLOSE_NO_FIRST;
    case "closeYesFirst":
      return CLOSE_YES_FIRST;
    case "noLiquidity":
      return NO_LIQUIDITY;
    case "invalid":
      return INVALID_INPUT;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/** Copy for a failed send, mapped from the program's `error_code` name (undefined -> generic). */
export function programErrorCopy(name: string | undefined, detail?: string): string {
  switch (name) {
    case "Paused":
      return TRADING_PAUSED;
    case "BookFull":
      return BOOK_FULL;
    case "InsufficientFill":
      return NO_LIQUIDITY;
    case "MarketSettled":
      return MARKET_SETTLED;
    case "MarketClosed":
      return MARKET_CLOSED;
    case "WouldCross":
      return WOULD_CROSS;
    case "WalletRejected":
      return SIGNING_CANCELLED;
    case "SelfMatch":
      return SELF_MATCH;
    default:
      return detail ? `${ORDER_COULD_NOT_BE_PLACED}: ${detail}` : ORDER_COULD_NOT_BE_PLACED;
  }
}

/**
 * "You pay $X" / "You receive $X" (copy audit: fill counts matter only to
 * makers watching the book's depth, not to the person placing this order,
 * so they're dropped here regardless of how many resting orders the trade
 * actually took).
 */
export function estimateLabel(costMicro: bigint): string {
  const verb = costMicro < 0n ? "You receive" : "You pay";
  const amount = formatUsd(costMicro < 0n ? -costMicro : costMicro);
  return `${verb} ${amount}`;
}

/**
 * "You win $Y if right" for a buy that would actually execute `matchedQty`
 * contracts right now (each pays out $1.00 to the winning side). When a
 * market order's `matchedQty` is less than what the user asked for
 * (`requestedQty`), the figure reflects only the matched amount and the
 * label says so in plain terms, rather than implying the full request wins.
 */
export function winIfRightLabel(matchedQty: bigint, requestedQty?: bigint): string {
  const base = `You win ${formatUsd(matchedQty * 1_000_000n)} if right`;
  if (requestedQty !== undefined && matchedQty < requestedQty) {
    return `${base} (for the ${matchedQty.toString()} that can trade now)`;
  }
  return base;
}

/** Estimate for a resting (limit) No-side order, which reserves collateral until it trades. */
export function lockedUntilFilledLabel(lockedMicro: bigint, perContractMicro?: bigint): string {
  const reserves = `Reserves ${formatUsd(lockedMicro)} until it trades`;
  return perContractMicro === undefined
    ? reserves
    : `Returns ${formatUsd(perContractMicro)} per contract when it trades. ${reserves}`;
}

/** "Settled at $X — Yes wins" / "— No wins". */
export function settledOutcomeCopy(outcome: "yes" | "no", settlementPriceMicro: bigint): string {
  return `Settled at ${formatUsd(settlementPriceMicro)} — ${outcome === "yes" ? "Yes" : "No"} wins`;
}

/** One-tap close label for the gating refusal: "Sell No" when Buy Yes is blocked, and vice versa. */
export function closeButtonLabel(code: "closeNoFirst" | "closeYesFirst"): string {
  return code === "closeNoFirst" ? ACTION_LABEL.sellNo : ACTION_LABEL.sellYes;
}
