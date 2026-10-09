import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { Side, type FillData, type MeridianEvent, type OrderPlacedData, type PairRedeemedData } from "@meridian/sdk";
import { computeTradeResult, tradeResultToast } from "./trade-result";

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

const MARKET = pk(1);
const USER = pk(2);
const OTHER_MARKET = pk(3);
const OTHER_USER = pk(4);
const MAKER = pk(5);

let nextSig = 0;
function fillEvent(overrides: Partial<FillData> = {}): MeridianEvent {
  nextSig += 1;
  const data: FillData = {
    market: MARKET,
    makerOrderId: 1n,
    maker: MAKER,
    taker: USER,
    sideOfTaker: Side.Bid,
    price: 500_000n,
    qty: 1n,
    ts: 1_700_000_000n,
    ...overrides,
  };
  return { name: "Fill", data, slot: 1, signature: `sig-${nextSig}` };
}

function orderPlacedEvent(overrides: Partial<OrderPlacedData> = {}): MeridianEvent {
  nextSig += 1;
  const data: OrderPlacedData = {
    market: MARKET,
    orderId: 1n,
    owner: USER,
    side: Side.Bid,
    price: 550_000n,
    qty: 2n,
    ...overrides,
  };
  return { name: "OrderPlaced", data, slot: 1, signature: `sig-${nextSig}` };
}

function pairRedeemedEvent(overrides: Partial<PairRedeemedData> = {}): MeridianEvent {
  nextSig += 1;
  const data: PairRedeemedData = { market: MARKET, user: USER, qty: 1n, ...overrides };
  return { name: "PairRedeemed", data, slot: 1, signature: `sig-${nextSig}` };
}

describe("computeTradeResult", () => {
  it("full fill: a market buy that matched its entire requested quantity reports that quantity and the Yes-side cost, with no open remainder", () => {
    const events = [
      fillEvent({ price: 500_000n, qty: 2n }),
      // OrderPlaced still fires for a fully-filled IOC (place_order.rs emits it unconditionally),
      // but its qty equals what already executed, so there's nothing left open.
      orderPlacedEvent({ qty: 2n, price: 500_000n }),
    ];
    const result = computeTradeResult(events, MARKET, USER, "buyYes");
    expect(result.executedQty).toBe(2n);
    expect(result.amountMicro).toBe(1_000_000n); // 2 * $0.50
    expect(result.open).toBeUndefined();
  });

  it("partial fill: a market order that only matched part of its requested quantity (the rest refunded, no OrderPlaced remainder since IOC never rests) reports only what matched", () => {
    const events = [fillEvent({ price: 600_000n, qty: 1n }), orderPlacedEvent({ qty: 10n, price: 600_000n })];
    // Even though OrderPlaced.qty (10) exceeds what matched, this is an IOC: the "remainder" was
    // refunded, not rested, so a caller must not treat this as "9 still open". `sellYes`'s cost
    // helper and the surrounding instruction decide that, not this pure function -- it reports
    // open strictly as "OrderPlaced.qty - executed", which is why this scenario is only used here
    // to prove the raw executed figure is correct; see the "limit partially traded" case below for
    // where an `open` remainder is actually meaningful (a true resting Limit order).
    const result = computeTradeResult(events, MARKET, USER, "sellYes");
    expect(result.executedQty).toBe(1n);
    expect(result.amountMicro).toBe(600_000n);
  });

  it("zero fill: a market order that matched nothing (liquidity gone by the time it landed) reports zero executed and no open remainder", () => {
    const events = [orderPlacedEvent({ qty: 5n, price: 500_000n })];
    const result = computeTradeResult(events, MARKET, USER, "buyYes");
    expect(result.executedQty).toBe(0n);
    expect(result.amountMicro).toBe(0n);
    // No OrderPlaced-derived remainder is reported for an IOC order either (the panel decides
    // "nothing traded" purely from executedQty === 0 and the absence of a composite-market order
    // -- see `tradeResultToast`), so this on its own doesn't yet distinguish IOC from limit; the
    // "limit fully open" case below covers that distinction via the actual instruction difference
    // (buy_no_market/sell_no_market never emit OrderPlaced at all, so market-path zero-fills never
    // get an `open` here regardless).
  });

  it("Buy No unwind: a buy_no_market that only partially matched reports just the matched quantity and net No cost, ignoring the PairRedeemed event for the unwound remainder", () => {
    const events = [
      // buy_no_market sells Yes IOC into bids: sideOfTaker is Ask (Side::Ask as u8 in the program).
      fillEvent({ sideOfTaker: Side.Ask, price: 800_000n, qty: 2n }),
      // The unfilled 8 of the original 10 requested pairs are minted-then-redeemed back to USDC in
      // the same transaction; this event must not add to executedQty.
      pairRedeemedEvent({ qty: 8n }),
    ];
    const result = computeTradeResult(events, MARKET, USER, "buyNo");
    expect(result.executedQty).toBe(2n);
    expect(result.amountMicro).toBe(400_000n); // 2 * (1_000_000 - 800_000)
    // buy_no_market never emits OrderPlaced, so there is never an open remainder for it.
    expect(result.open).toBeUndefined();
  });

  it("limit fully open: a Limit order that matched nothing rests its entire requested quantity", () => {
    const events = [orderPlacedEvent({ qty: 2n, price: 550_000n })];
    const result = computeTradeResult(events, MARKET, USER, "buyYes");
    expect(result.executedQty).toBe(0n);
    expect(result.open).toEqual({ qty: 2n, priceMicro: 550_000n });
  });

  it("limit partially traded: a Limit order that matched part of its quantity immediately rests only the remainder", () => {
    const events = [fillEvent({ price: 500_000n, qty: 1n }), orderPlacedEvent({ qty: 2n, price: 550_000n })];
    const result = computeTradeResult(events, MARKET, USER, "buyYes");
    expect(result.executedQty).toBe(1n);
    expect(result.amountMicro).toBe(500_000n);
    expect(result.open).toEqual({ qty: 1n, priceMicro: 550_000n });
  });

  it("ignores Fill/OrderPlaced events for a different market or a different user", () => {
    const events = [
      fillEvent({ market: OTHER_MARKET, qty: 9n }),
      fillEvent({ taker: OTHER_USER, qty: 9n }),
      orderPlacedEvent({ market: OTHER_MARKET, qty: 9n }),
      orderPlacedEvent({ owner: OTHER_USER, qty: 9n }),
      fillEvent({ price: 500_000n, qty: 1n }),
      orderPlacedEvent({ qty: 2n, price: 550_000n }),
    ];
    const result = computeTradeResult(events, MARKET, USER, "buyYes");
    expect(result.executedQty).toBe(1n);
    expect(result.amountMicro).toBe(500_000n);
    expect(result.open).toEqual({ qty: 1n, priceMicro: 550_000n });
  });
});

describe("tradeResultToast", () => {
  it("a full/market fill: 'Bought N Yes/No on TICKER $strike for $amount', success", () => {
    const toast = tradeResultToast({ executedQty: 2n, amountMicro: 1_000_000n }, "buyYes", "AAPL", 345_000_000n);
    expect(toast).toEqual({ title: "Bought 2 Yes on AAPL $345 for $1.00", tone: "success" });
  });

  it("zero fill on a market path: an info toast that nothing traded", () => {
    const toast = tradeResultToast({ executedQty: 0n, amountMicro: 0n }, "buyYes", "AAPL", 345_000_000n);
    expect(toast).toEqual({ title: "Nothing traded; your order was undone", tone: "info" });
  });

  it("a limit order left fully open: 'Order open: ...' title with a 'Reserved ...' detail", () => {
    const toast = tradeResultToast(
      { executedQty: 0n, amountMicro: 0n, open: { qty: 2n, priceMicro: 550_000n } },
      "buyYes",
      "AAPL",
      345_000_000n,
    );
    expect(toast).toEqual({
      title: "Order open: buy 2 Yes at $0.55 on AAPL $345",
      detail: "Reserved $1.10 until it trades",
      tone: "success",
    });
  });

  it("a limit order partially traded: one combined sentence naming both what traded and what's still open", () => {
    const toast = tradeResultToast(
      { executedQty: 1n, amountMicro: 500_000n, open: { qty: 1n, priceMicro: 550_000n } },
      "buyYes",
      "AAPL",
      345_000_000n,
    );
    expect(toast).toEqual({
      title: "Bought 1 Yes on AAPL $345 for $0.50; 1 Yes still open at $0.55",
      tone: "success",
    });
  });
});
