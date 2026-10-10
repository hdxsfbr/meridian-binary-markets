/**
 * Every user-facing string the trade panel shows, in one place
 * (contracts/frontend.md, global rule: UI copy is for the end user, never
 * implementation commentary — no provider names, "mock"/"simulated"
 * asides, or raw program error codes). `trade-copy.test.ts` asserts none of
 * these strings (or the values the formatting functions produce) contain a
 * forbidden word.
 */

import type { Action, GuidanceErrorCode } from "@meridian/sdk";
import { formatStrike, formatUsd } from "./format";

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

/*
 * ---------------------------------------------------------------------
 * Toast copy (Andre's complaint: nothing confirms a successful order
 * except finding it later on /portfolio). The trade-panel toast strings
 * (`marketOrderToastTitle`, `limitOrderToastTitle`, `limitOrderToastDetail`,
 * `stillOpenFragment`, `NOTHING_TRADED`) are fed by `trade-result.ts`'s
 * confirmed, event-derived numbers, never a pre-send estimate; the rest are
 * built from the same numbers the maker form/portfolio page already
 * compute for their own inline copy. Never a transaction signature, an
 * RPC/program term, or a fill/resting/escrow word (see trade-copy.test.ts).
 * ---------------------------------------------------------------------
 */

const QUOTE_VERB: Record<Action, "Bought" | "Sold"> = {
  buyYes: "Bought",
  buyNo: "Bought",
  sellYes: "Sold",
  sellNo: "Sold",
};

const QUOTE_SIDE: Record<Action, "Yes" | "No"> = {
  buyYes: "Yes",
  buyNo: "No",
  sellYes: "Yes",
  sellNo: "No",
};

/** "Bought 2 Yes on AAPL $345 for $1.10" / "Sold 2 No on AAPL $345 for $0.90" -- what a confirmed transaction actually executed (`trade-result.ts`'s `executedQty`/`amountMicro`), never a pre-send estimate. */
export function marketOrderToastTitle(action: Action, ticker: string, strikeMicro: bigint, matchedQty: bigint, amountMicro: bigint): string {
  const amount = amountMicro < 0n ? -amountMicro : amountMicro;
  return `${QUOTE_VERB[action]} ${matchedQty.toString()} ${QUOTE_SIDE[action]} on ${ticker} ${formatStrike(strikeMicro)} for ${formatUsd(amount)}`;
}

/** "Order open: buy 2 Yes at $0.55 on AAPL $345" -- the quantity a confirmed limit order actually left resting on the book (`trade-result.ts`'s `open.qty`), which can be less than what was requested if part of it traded immediately. */
export function limitOrderToastTitle(action: Action, ticker: string, strikeMicro: bigint, qty: bigint, priceMicro: bigint): string {
  const verb = action === "buyYes" || action === "buyNo" ? "buy" : "sell";
  return `Order open: ${verb} ${qty.toString()} ${QUOTE_SIDE[action]} at ${formatUsd(priceMicro)} on ${ticker} ${formatStrike(strikeMicro)}`;
}

/**
 * "Reserved $1.10 until it trades" -- the limit order toast's detail
 * line, for the quantity actually still open (never the originally
 * requested quantity if part of it already traded). A resting Buy
 * Yes/Buy No (or the Sell No bid that rests toward a later pair
 * redemption) locks USDC up front, so `amountMicro` is a dollar figure; a
 * resting Sell Yes locks the Yes contracts themselves (there is no dollar
 * escrow to name), so it reports `qty` instead.
 */
export function limitOrderToastDetail(action: Action, amountMicro: bigint, qty: bigint): string {
  if (action === "sellYes") {
    return `Reserved ${qty.toString()} Yes until it trades`;
  }
  return `Reserved ${formatUsd(amountMicro)} until it trades`;
}

/** A market-path transaction that executed nothing (e.g. the liquidity it was about to take was gone by the time it landed); the user's funds/tokens were refunded in the same transaction. */
export const NOTHING_TRADED = "Nothing traded; your order was undone";

/** Shown when the confirmed transaction's own result couldn't be read back in time; the trade itself already landed. */
export const ORDER_CONFIRMED_FALLBACK = "Order confirmed. See the result in Portfolio.";

/** "1 Yes still open at $0.55" -- the unmatched remainder of a limit order that also traded some quantity in the same transaction. */
export function stillOpenFragment(action: Action, qty: bigint, priceMicro: bigint): string {
  return `${qty.toString()} ${QUOTE_SIDE[action]} still open at ${formatUsd(priceMicro)}`;
}

export type PlacedQuote = { side: "bid" | "ask"; priceMicro: bigint; qty: bigint };

/** "Quotes placed on AAPL $345: sell 2 at $0.55, buy 2 at $0.45" -- every quote that actually posted in one submit, for one market. */
export function quotesPlacedToastTitle(ticker: string, strikeMicro: bigint, quotes: readonly PlacedQuote[]): string {
  const parts = quotes.map((q) => `${q.side === "bid" ? "buy" : "sell"} ${q.qty.toString()} at ${formatUsd(q.priceMicro)}`);
  return `Quotes placed on ${ticker} ${formatStrike(strikeMicro)}: ${parts.join(", ")}`;
}

export const QUOTE_CANCELLED = "Quote cancelled";

/** "Cancelled N quotes" (singular "quote" for N=1), for "Cancel all on this market". */
export function quotesCancelledToastTitle(count: number): string {
  return `Cancelled ${count.toString()} quote${count === 1 ? "" : "s"}`;
}

/** "Collected $2.00 from AAPL $345" -- a single redeem (winning or pair). */
/** "Minted 5 pairs on AAPL $345 for $5.00" -- Mint pair on Portfolio's Your quotes. */
export function mintedPairsToastTitle(qty: bigint, ticker: string, strikeMicro: bigint): string {
  const pairs = qty === 1n ? "1 pair" : `${qty} pairs`;
  return `Minted ${pairs} on ${ticker} ${formatStrike(strikeMicro)} for ${formatUsd(qty * 1_000_000n)}`;
}

export function redeemCollectedToastTitle(amountMicro: bigint, ticker: string, strikeMicro: bigint): string {
  return `Collected ${formatUsd(amountMicro)} from ${ticker} ${formatStrike(strikeMicro)}`;
}

/** "Collected $5.00 across 3 markets" -- "Redeem all", reflecting only what actually went through. */
export function redeemAllCollectedToastTitle(amountMicro: bigint, marketCount: number): string {
  return `Collected ${formatUsd(amountMicro)} across ${marketCount.toString()} market${marketCount === 1 ? "" : "s"}`;
}

/** "Removed 5 No tokens; rent returned" -- "Remove from wallet" on a settled losing position. */
export function removedFromWalletToastTitle(qty: bigint, side: "yes" | "no"): string {
  const label = side === "yes" ? "Yes" : "No";
  return `Removed ${qty.toString()} ${label} token${qty === 1n ? "" : "s"}; rent returned`;
}

export const VIEW_IN_PORTFOLIO = "View in Portfolio";
