import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeBook, encodeBookForTest, type Book, type Order } from "../src/book";
import { describeTransientState, toInstructionPlan, type Position } from "../src/intent";

function order(id: bigint, owner: PublicKey, price: bigint, remaining: bigint, seq: bigint): Order {
  return { id, owner, price, remaining, seq };
}

const emptyPosition: Position = { yes: 0n, no: 0n, mintedPairs: 0n };

function bookWith(bids: Order[], asks: Order[]): Book {
  return decodeBook(encodeBookForTest({ capacity: 16, bids, asks }));
}

describe("toInstructionPlan: buyYes", () => {
  it("market: bids IOC into asks, limit = last planned fill price, cost = sum(qty * price)", () => {
    const maker = PublicKey.unique();
    const book = bookWith([], [order(1n, maker, 600_000n, 10n, 1n)]);

    const plan = toInstructionPlan({ action: "buyYes", kind: "market", qty: 4n }, emptyPosition, book);

    expect(plan).toMatchObject({
      ix: "place_order",
      side: 0,
      price: 600_000n,
      qty: 4n,
      tif: 1,
      estimate: { cost: 2_400_000n, fills: 1 },
    });
  });

  it("limit: bids Limit at the given price", () => {
    const book = bookWith([], []);
    const plan = toInstructionPlan(
      { action: "buyYes", kind: "limit", qty: 4n, price: 600_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({ ix: "place_order", side: 0, price: 600_000n, qty: 4n, tif: 0 });
  });

  it("is refused with closeNoFirst when holding (non-minted) No", () => {
    const book = bookWith([], []);
    const position: Position = { yes: 0n, no: 5n, mintedPairs: 0n };
    const plan = toInstructionPlan({ action: "buyYes", kind: "market", qty: 4n }, position, book);
    expect(plan).toEqual({ code: "closeNoFirst" });
  });

  it("is not refused when the held No is entirely minted-pair exempt", () => {
    const book = bookWith([], [order(1n, PublicKey.unique(), 600_000n, 10n, 1n)]);
    const position: Position = { yes: 5n, no: 5n, mintedPairs: 5n };
    const plan = toInstructionPlan({ action: "buyYes", kind: "market", qty: 4n }, position, book);
    expect(plan).not.toHaveProperty("code");
  });

  it("market against an empty book returns noLiquidity", () => {
    const book = bookWith([], []);
    const plan = toInstructionPlan({ action: "buyYes", kind: "market", qty: 4n }, emptyPosition, book);
    expect(plan).toEqual({ code: "noLiquidity" });
  });
});

describe("toInstructionPlan: sellYes", () => {
  it("market: asks IOC into bids, cost is negative (proceeds)", () => {
    const maker = PublicKey.unique();
    const book = bookWith([order(1n, maker, 600_000n, 10n, 1n)], []);

    const plan = toInstructionPlan({ action: "sellYes", kind: "market", qty: 4n }, emptyPosition, book);

    expect(plan).toMatchObject({
      ix: "place_order",
      side: 1,
      price: 600_000n,
      qty: 4n,
      tif: 1,
      estimate: { cost: -2_400_000n, fills: 1 },
    });
  });

  it("limit: asks Limit at the given price", () => {
    const book = bookWith([], []);
    const plan = toInstructionPlan(
      { action: "sellYes", kind: "limit", qty: 4n, price: 600_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({ ix: "place_order", side: 1, price: 600_000n, qty: 4n, tif: 0 });
  });
});

describe("toInstructionPlan: buyNo", () => {
  it("market: buy_no_market with minYesPrice and cost = qty * (1e6 - bestBid) for a single fill", () => {
    const maker = PublicKey.unique();
    const book = bookWith([order(1n, maker, 600_000n, 10n, 1n)], []);

    const plan = toInstructionPlan({ action: "buyNo", kind: "market", qty: 4n }, emptyPosition, book);

    expect(plan).toMatchObject({
      ix: "buy_no_market",
      qty: 4n,
      minYesPrice: 600_000n,
      estimate: { cost: 4n * (1_000_000n - 600_000n), fills: 1 },
    });
  });

  it("limit at or above the best available No price executes as buy_no_market capped at that price", () => {
    const maker = PublicKey.unique();
    // Resting Yes bid at $0.50 = No offered at $0.50. A No limit at $0.55 (Yes ask $0.45) crosses it.
    const book = bookWith([order(1n, maker, 500_000n, 10n, 1n)], []);
    const plan = toInstructionPlan({ action: "buyNo", kind: "limit", qty: 2n, price: 550_000n }, emptyPosition, book);
    expect(plan).toMatchObject({ ix: "buy_no_market", qty: 2n, minYesPrice: 500_000n, makers: [maker] });
    expect((plan as { estimate: { cost: bigint } }).estimate.cost).toBe(2n * 500_000n);
  });

  it("limit: buy_no_limit posts the complementary Yes ask price", () => {
    const book = bookWith([], []);
    // No price 400_000 -> Yes ask price 600_000.
    const plan = toInstructionPlan(
      { action: "buyNo", kind: "limit", qty: 4n, price: 400_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({ ix: "buy_no_limit", qty: 4n, price: 600_000n });
  });

  it("is refused with closeYesFirst when holding (non-minted) Yes", () => {
    const book = bookWith([order(1n, PublicKey.unique(), 600_000n, 10n, 1n)], []);
    const position: Position = { yes: 5n, no: 0n, mintedPairs: 0n };
    const plan = toInstructionPlan({ action: "buyNo", kind: "market", qty: 4n }, position, book);
    expect(plan).toEqual({ code: "closeYesFirst" });
  });

  it("is not refused when the held Yes is entirely minted-pair exempt", () => {
    const book = bookWith([order(1n, PublicKey.unique(), 600_000n, 10n, 1n)], []);
    const position: Position = { yes: 5n, no: 5n, mintedPairs: 5n };
    const plan = toInstructionPlan({ action: "buyNo", kind: "market", qty: 4n }, position, book);
    expect(plan).not.toHaveProperty("code");
  });

  it("market against an empty book returns noLiquidity", () => {
    const book = bookWith([], []);
    const plan = toInstructionPlan({ action: "buyNo", kind: "market", qty: 4n }, emptyPosition, book);
    expect(plan).toEqual({ code: "noLiquidity" });
  });
});

describe("toInstructionPlan: sellNo", () => {
  it("market: sell_no_market with maxYesPrice and negative cost (proceeds)", () => {
    const maker = PublicKey.unique();
    const book = bookWith([], [order(1n, maker, 600_000n, 10n, 1n)]);

    const plan = toInstructionPlan({ action: "sellNo", kind: "market", qty: 4n }, emptyPosition, book);

    expect(plan).toMatchObject({
      ix: "sell_no_market",
      qty: 4n,
      maxYesPrice: 600_000n,
      estimate: { cost: -(4n * (1_000_000n - 600_000n)), fills: 1 },
    });
  });

  it("limit: place_order bid Limit at the complementary Yes price", () => {
    const book = bookWith([], []);
    const plan = toInstructionPlan(
      { action: "sellNo", kind: "limit", qty: 4n, price: 400_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({ ix: "place_order", side: 0, price: 600_000n, qty: 4n, tif: 0 });
  });

  it("market against an empty book returns noLiquidity", () => {
    const book = bookWith([], []);
    const plan = toInstructionPlan({ action: "sellNo", kind: "market", qty: 4n }, emptyPosition, book);
    expect(plan).toEqual({ code: "noLiquidity" });
  });
});

describe("toInstructionPlan: validation", () => {
  it("rejects qty <= 0", () => {
    const book = bookWith([], []);
    const plan = toInstructionPlan({ action: "buyYes", kind: "market", qty: 0n }, emptyPosition, book);
    expect(plan).toEqual({ code: "invalid" });
  });

  it("rejects a limit order missing a price", () => {
    const book = bookWith([], []);
    const plan = toInstructionPlan({ action: "buyYes", kind: "limit", qty: 1n }, emptyPosition, book);
    expect(plan).toEqual({ code: "invalid" });
  });

  it("rejects a price of 0 or >= 1_000_000", () => {
    const book = bookWith([], []);
    expect(
      toInstructionPlan({ action: "buyYes", kind: "limit", qty: 1n, price: 0n }, emptyPosition, book),
    ).toEqual({ code: "invalid" });
    expect(
      toInstructionPlan({ action: "buyYes", kind: "limit", qty: 1n, price: 1_000_000n }, emptyPosition, book),
    ).toEqual({ code: "invalid" });
  });
});

describe("toInstructionPlan: gating uses pairsHeld = min(yes, no), not mintedPairs", () => {
  it("after a Buy No market (yes 0, no q), buyYes IS gated", () => {
    const book = bookWith([], [order(1n, PublicKey.unique(), 600_000n, 10n, 1n)]);
    const position: Position = { yes: 0n, no: 5n, mintedPairs: 0n };
    const plan = toInstructionPlan({ action: "buyYes", kind: "market", qty: 4n }, position, book);
    expect(plan).toEqual({ code: "closeNoFirst" });
  });

  it("an LP holding equal Yes and No (never minted) is not gated either direction", () => {
    const yesAsks = [order(1n, PublicKey.unique(), 600_000n, 10n, 1n)];
    const noBids = [order(2n, PublicKey.unique(), 400_000n, 10n, 2n)];
    // mintedPairs: 0n -- this position arose entirely from open-market
    // trades, not from `mint_pair`, yet it is just as exempt as a mint.
    const position: Position = { yes: 5n, no: 5n, mintedPairs: 0n };

    const buyYesPlan = toInstructionPlan({ action: "buyYes", kind: "market", qty: 4n }, position, bookWith([], yesAsks));
    expect(buyYesPlan).not.toHaveProperty("code");

    const buyNoPlan = toInstructionPlan({ action: "buyNo", kind: "market", qty: 4n }, position, bookWith(noBids, []));
    expect(buyNoPlan).not.toHaveProperty("code");
  });

  it("net exposure beyond the paired amount still gates (yes=5, no=8 -> net No = 3)", () => {
    const book = bookWith([], [order(1n, PublicKey.unique(), 600_000n, 10n, 1n)]);
    const position: Position = { yes: 5n, no: 8n, mintedPairs: 0n };
    const plan = toInstructionPlan({ action: "buyYes", kind: "market", qty: 4n }, position, book);
    expect(plan).toEqual({ code: "closeNoFirst" });
  });
});

describe("toInstructionPlan: a market intent's price is the worst acceptable price", () => {
  it("buyYes market stops at the given worst price instead of sweeping the whole book", () => {
    const maker1 = PublicKey.unique();
    const maker2 = PublicKey.unique();
    const asks = [order(1n, maker1, 600_000n, 3n, 1n), order(2n, maker2, 700_000n, 10n, 2n)];
    const book = bookWith([], asks);

    const plan = toInstructionPlan(
      { action: "buyYes", kind: "market", qty: 5n, price: 650_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({ ix: "place_order", side: 0, price: 600_000n, estimate: { fills: 1 } });
  });

  it("sellYes market stops at the given worst price", () => {
    const bids = [order(1n, PublicKey.unique(), 600_000n, 3n, 1n), order(2n, PublicKey.unique(), 500_000n, 10n, 2n)];
    const book = bookWith(bids, []);

    const plan = toInstructionPlan(
      { action: "sellYes", kind: "market", qty: 5n, price: 550_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({ ix: "place_order", side: 1, price: 600_000n, estimate: { fills: 1 } });
  });

  it("buyNo market applies the Yes complement of the given No worst price", () => {
    // No worst price 350_000 -> Yes complement floor 650_000: only the
    // 700_000 bid (price >= 650_000) qualifies, not the 600_000 one.
    const bids = [order(1n, PublicKey.unique(), 700_000n, 3n, 1n), order(2n, PublicKey.unique(), 600_000n, 10n, 2n)];
    const book = bookWith(bids, []);

    const plan = toInstructionPlan(
      { action: "buyNo", kind: "market", qty: 3n, price: 350_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({ ix: "buy_no_market", minYesPrice: 700_000n, estimate: { fills: 1 } });
  });

  it("sellNo market applies the Yes complement of the given No worst price", () => {
    // No worst price 350_000 -> Yes complement ceiling 650_000: only the
    // 600_000 ask (price <= 650_000) qualifies, not the 700_000 one.
    const asks = [order(1n, PublicKey.unique(), 600_000n, 3n, 1n), order(2n, PublicKey.unique(), 700_000n, 10n, 2n)];
    const book = bookWith([], asks);

    const plan = toInstructionPlan(
      { action: "sellNo", kind: "market", qty: 3n, price: 350_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({ ix: "sell_no_market", maxYesPrice: 600_000n, estimate: { fills: 1 } });
  });
});

describe("toInstructionPlan: sellNo limit reports deposit and eventualProceeds separately", () => {
  it("deposit = yesPrice * qty (escrow now); eventualProceeds = noPrice * qty (net, once filled and redeemed)", () => {
    const book = bookWith([], []);
    // No price 400_000 -> Yes price 600_000.
    const plan = toInstructionPlan(
      { action: "sellNo", kind: "limit", qty: 4n, price: 400_000n },
      emptyPosition,
      book,
    );
    expect(plan).toMatchObject({
      ix: "place_order",
      price: 600_000n,
      estimate: { deposit: 2_400_000n, eventualProceeds: 1_600_000n },
    });
  });
});

describe("describeTransientState", () => {
  it("renders noHeldYesResting when No is available and a Yes ask rests", () => {
    expect(describeTransientState({ noAvailable: 2n, restingAskQty: 2n })).toBe("noHeldYesResting");
  });

  it("is null once there is no resting Yes ask", () => {
    expect(describeTransientState({ noAvailable: 2n, restingAskQty: 0n })).toBeNull();
  });

  it("is null for a plain minted pair (no No available beyond the held pair)", () => {
    expect(describeTransientState({ noAvailable: 0n, restingAskQty: 2n })).toBeNull();
  });
});
