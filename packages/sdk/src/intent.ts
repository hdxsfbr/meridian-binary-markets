/**
 * Translation layer from a trade-panel `Intent` to an on-chain instruction
 * plan (contracts/frontend.md "Translation layer", research.md R8). Pure
 * and side-effect free: given the user's wallet position and the current
 * `Book` (book.ts), it either returns the instruction to send plus a cost
 * estimate, or a `GuidanceError` the UI renders as copy (FR-014/FR-015),
 * never as a raw program error code.
 */

import { PublicKey } from "@solana/web3.js";
import { type Book, type Order, bestAsk, bestBid, plannedFills } from "#book";

const ONE_USDC = 1_000_000n;
const PRICE_MIN = 1n;
const PRICE_MAX = 999_999n;
const MAX_FILLS = 8;

export type Action = "buyYes" | "buyNo" | "sellYes" | "sellNo";
export type Kind = "market" | "limit";

export type Intent = {
  action: Action;
  kind: Kind;
  qty: bigint;
  price?: bigint;
};

/** Wallet position for a market. `mintedPairs` (equal Yes and No from minting) is gating-exempt (FR-015). */
export type Position = {
  yes: bigint;
  no: bigint;
  mintedPairs: bigint;
};

export type GuidanceErrorCode = "closeNoFirst" | "closeYesFirst" | "noLiquidity" | "invalid";

export type GuidanceError = { code: GuidanceErrorCode };

/**
 * `price * qty` or `0` cost estimate, signed: positive is paid by the user,
 * negative is received. `sell_no_limit` (framed as `place_order(Bid,
 * Limit)`) additionally reports `deposit` (the USDC escrow required to post
 * the resting bid, `yesPrice * qty`, equal to `cost` for that plan) and
 * `eventualProceeds` (the net No proceeds the user will have once the bid
 * fills *and* the resulting pair is redeemed, `qty * noPrice`) separately,
 * since those are two different numbers at two different times -- `cost`
 * alone conflating them as a single negative "proceeds" figure understated
 * the actual USDC the user must have on hand right now.
 */
export type Estimate = { cost: bigint; fills: number; deposit?: bigint; eventualProceeds?: bigint };

/** Order-book side as the on-chain program encodes it (mirrors `Side` in types.ts: Bid = 0, Ask = 1). */
export const PlaceOrderSide = { Bid: 0, Ask: 1 } as const;

/** Time-in-force as the on-chain `place_order` encodes it: Limit = 0 (rest), IOC = 1 (fill-or-refund). */
export const TimeInForce = { Limit: 0, Ioc: 1 } as const;

export type PlaceOrderPlan = {
  ix: "place_order";
  side: 0 | 1;
  price: bigint;
  qty: bigint;
  tif: 0 | 1;
  makers: PublicKey[];
  estimate: Estimate;
};

export type BuyNoMarketPlan = {
  ix: "buy_no_market";
  qty: bigint;
  minYesPrice: bigint;
  makers: PublicKey[];
  estimate: Estimate;
};

export type BuyNoLimitPlan = {
  ix: "buy_no_limit";
  qty: bigint;
  price: bigint;
  estimate: Estimate;
};

export type SellNoMarketPlan = {
  ix: "sell_no_market";
  qty: bigint;
  maxYesPrice: bigint;
  makers: PublicKey[];
  estimate: Estimate;
};

export type InstructionPlan = PlaceOrderPlan | BuyNoMarketPlan | BuyNoLimitPlan | SellNoMarketPlan;

function isPriceInRange(price: bigint): boolean {
  return price >= PRICE_MIN && price <= PRICE_MAX;
}

function validateIntent(intent: Intent): GuidanceError | undefined {
  if (intent.qty <= 0n) {
    return { code: "invalid" };
  }
  if (intent.kind === "limit") {
    if (intent.price === undefined || !isPriceInRange(intent.price)) {
      return { code: "invalid" };
    }
  } else if (intent.price !== undefined && !isPriceInRange(intent.price)) {
    return { code: "invalid" };
  }
  return undefined;
}

/**
 * Gating is exempt for pairs currently held, `pairsHeld = min(yes, no)`
 * (FR-015) -- not `mintedPairs`, which only tracks net mint history and can
 * disagree with current holdings (e.g. an LP that bought into an equal
 * Yes/No position on the open market, never having minted anything, is
 * just as exempt as one who minted it). Net exposure beyond that exempt
 * pair is what gates the opposite side: buying Yes is blocked while there
 * is net (non-paired) No exposure, and vice versa.
 */
function checkGating(action: Action, position: Position): GuidanceError | undefined {
  const pairsHeld = position.yes < position.no ? position.yes : position.no;
  const netNo = position.no - pairsHeld;
  const netYes = position.yes - pairsHeld;
  if (action === "buyYes" && netNo > 0n) {
    return { code: "closeNoFirst" };
  }
  if (action === "buyNo" && netYes > 0n) {
    return { code: "closeYesFirst" };
  }
  return undefined;
}

/** Sum of `qty * price` over a set of fills. */
function notional(fills: { qty: bigint; price: bigint }[]): bigint {
  return fills.reduce((sum, f) => sum + f.qty * f.price, 0n);
}

/**
 * Translates a trade-panel `Intent` into an on-chain instruction plan, or a
 * `GuidanceError` for the UI to render as copy. See module doc and
 * contracts/frontend.md "Translation layer" for the rules.
 */
export function toInstructionPlan(
  intent: Intent,
  position: Position,
  book: Book,
): InstructionPlan | GuidanceError {
  const invalid = validateIntent(intent);
  if (invalid) {
    return invalid;
  }

  const gating = checkGating(intent.action, position);
  if (gating) {
    return gating;
  }

  const { action, kind, qty } = intent;

  switch (action) {
    case "buyYes": {
      if (kind === "market") {
        // A market intent's `price`, if given, is the worst acceptable
        // price (the highest the user will pay per Yes); defaults to
        // sweeping the whole book.
        const worstPrice = intent.price ?? PRICE_MAX;
        const { fills } = plannedFills(book, "bid", worstPrice, qty, MAX_FILLS);
        if (fills.length === 0) {
          return { code: "noLiquidity" };
        }
        const limitPrice = fills.length === 1 ? (bestAsk(book) as Order).price : fills[fills.length - 1].price;
        return {
          ix: "place_order",
          side: PlaceOrderSide.Bid,
          price: limitPrice,
          qty,
          tif: TimeInForce.Ioc,
          makers: fills.map((f) => f.maker),
          estimate: { cost: notional(fills), fills: fills.length },
        };
      }
      const price = intent.price as bigint;
      const { fills } = plannedFills(book, "bid", price, qty, MAX_FILLS);
      return {
        ix: "place_order",
        side: PlaceOrderSide.Bid,
        price,
        qty,
        tif: TimeInForce.Limit,
        makers: fills.map((f) => f.maker),
        estimate: { cost: qty * price, fills: fills.length },
      };
    }

    case "sellYes": {
      if (kind === "market") {
        // Worst acceptable price here is the lowest the user will accept
        // per Yes sold; defaults to sweeping the whole book.
        const worstPrice = intent.price ?? PRICE_MIN;
        const { fills } = plannedFills(book, "ask", worstPrice, qty, MAX_FILLS);
        if (fills.length === 0) {
          return { code: "noLiquidity" };
        }
        const limitPrice = fills.length === 1 ? (bestBid(book) as Order).price : fills[fills.length - 1].price;
        return {
          ix: "place_order",
          side: PlaceOrderSide.Ask,
          price: limitPrice,
          qty,
          tif: TimeInForce.Ioc,
          makers: fills.map((f) => f.maker),
          estimate: { cost: -notional(fills), fills: fills.length },
        };
      }
      const price = intent.price as bigint;
      const { fills } = plannedFills(book, "ask", price, qty, MAX_FILLS);
      return {
        ix: "place_order",
        side: PlaceOrderSide.Ask,
        price,
        qty,
        tif: TimeInForce.Limit,
        makers: fills.map((f) => f.maker),
        estimate: { cost: -(qty * price), fills: fills.length },
      };
    }

    case "buyNo": {
      if (kind === "market") {
        // Mints `qty` pairs then sells Yes IOC into bids. A market intent's
        // `price`, if given, is the worst acceptable price *in No terms*
        // (the most the user will pay per No); its Yes complement is the
        // least the sold Yes may fetch, since No cost = 1_000_000 - yesPrice.
        // Defaults to sweeping the whole book.
        const worstYesPrice = intent.price !== undefined ? ONE_USDC - intent.price : PRICE_MIN;
        const { fills } = plannedFills(book, "ask", worstYesPrice, qty, MAX_FILLS);
        if (fills.length === 0) {
          return { code: "noLiquidity" };
        }
        const minYesPrice = fills[fills.length - 1].price;
        const cost = fills.reduce((sum, f) => sum + f.qty * (ONE_USDC - f.price), 0n);
        return {
          ix: "buy_no_market",
          qty,
          minYesPrice,
          makers: fills.map((f) => f.maker),
          estimate: { cost, fills: fills.length },
        };
      }
      // buy_no_limit: UI passes the No price the user wants to post; the
      // posted Yes ask price is the complement.
      const noPrice = intent.price as bigint;
      const yesPrice = ONE_USDC - noPrice;
      if (!isPriceInRange(yesPrice)) {
        return { code: "invalid" };
      }
      return {
        ix: "buy_no_limit",
        qty,
        price: yesPrice,
        estimate: { cost: qty * ONE_USDC, fills: 0 },
      };
    }

    case "sellNo": {
      if (kind === "market") {
        // Buys Yes IOC from asks then redeems the filled pairs. A market
        // intent's `price`, if given, is the worst acceptable price *in No
        // terms* (the least the user will accept per No sold); its Yes
        // complement is the most the bought Yes may cost, since No proceeds
        // = 1_000_000 - yesPrice. Defaults to sweeping the whole book.
        const worstYesPrice = intent.price !== undefined ? ONE_USDC - intent.price : PRICE_MAX;
        const { fills } = plannedFills(book, "bid", worstYesPrice, qty, MAX_FILLS);
        if (fills.length === 0) {
          return { code: "noLiquidity" };
        }
        const maxYesPrice = fills[fills.length - 1].price;
        const proceeds = fills.reduce((sum, f) => sum + f.qty * (ONE_USDC - f.price), 0n);
        return {
          ix: "sell_no_market",
          qty,
          maxYesPrice,
          makers: fills.map((f) => f.maker),
          estimate: { cost: -proceeds, fills: fills.length },
        };
      }
      // sell_no_limit is framed as place_order(Bid, Limit): on fill the
      // user holds a pair and redeems (research.md R8).
      const noPrice = intent.price as bigint;
      const yesPrice = ONE_USDC - noPrice;
      if (!isPriceInRange(yesPrice)) {
        return { code: "invalid" };
      }
      const { fills } = plannedFills(book, "bid", yesPrice, qty, MAX_FILLS);
      // Posting this bid escrows `yesPrice * qty` USDC now (`deposit`); only
      // once it fills and the resulting pair is redeemed does the user see
      // the net No proceeds, `qty * noPrice` (`eventualProceeds`).
      const deposit = qty * yesPrice;
      const eventualProceeds = qty * noPrice;
      return {
        ix: "place_order",
        side: PlaceOrderSide.Bid,
        price: yesPrice,
        qty,
        tif: TimeInForce.Limit,
        makers: fills.map((f) => f.maker),
        estimate: { cost: deposit, fills: fills.length, deposit, eventualProceeds },
      };
    }

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * FR-014's transient display: when a `buy_no_limit` has not fully filled,
 * the user holds both Yes and No (beyond any minted-pair baseline) while a
 * Yes ask still rests on the book. Returns `"noHeldYesResting"` in that
 * case so the UI can render "No held, Yes resting"; otherwise `null`.
 */
export function describeTransientState(
  position: Position,
  restingYesAsks: Order[],
): "noHeldYesResting" | null {
  const heldYes = position.yes - position.mintedPairs;
  const heldNo = position.no - position.mintedPairs;
  if (heldYes > 0n && heldNo > 0n && restingYesAsks.length > 0) {
    return "noHeldYesResting";
  }
  return null;
}
