import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { bestAsk, bestBid, decodeBook, depth, encodeBookForTest, plannedFills, type Order } from "../src/book";

function order(id: bigint, owner: PublicKey, price: bigint, remaining: bigint, seq: bigint): Order {
  return { id, owner, price, remaining, seq };
}

describe("decodeBook", () => {
  it("round-trips bids and asks for capacity 16", () => {
    const market = PublicKey.unique();
    const usdcEscrow = PublicKey.unique();
    const yesEscrow = PublicKey.unique();
    const makerA = PublicKey.unique();
    const makerB = PublicKey.unique();

    const bids = [order(1n, makerA, 600_000n, 10n, 1n), order(2n, makerB, 550_000n, 5n, 2n)];
    const asks = [order(3n, makerB, 650_000n, 8n, 3n), order(4n, makerA, 700_000n, 4n, 4n)];

    const raw = encodeBookForTest({
      market,
      usdcEscrow,
      yesEscrow,
      nextOrderId: 5n,
      nextSeq: 5n,
      capacity: 16,
      bids,
      asks,
    });

    const book = decodeBook(raw);
    expect(book.header.market.equals(market)).toBe(true);
    expect(book.header.usdcEscrow.equals(usdcEscrow)).toBe(true);
    expect(book.header.yesEscrow.equals(yesEscrow)).toBe(true);
    expect(book.header.nextOrderId).toBe(5n);
    expect(book.header.nextSeq).toBe(5n);
    expect(book.header.capacity).toBe(16);
    expect(book.header.bidCount).toBe(2);
    expect(book.header.askCount).toBe(2);

    expect(book.bids).toHaveLength(2);
    expect(book.bids[0].id).toBe(1n);
    expect(book.bids[0].price).toBe(600_000n);
    expect(book.bids[0].owner.equals(makerA)).toBe(true);
    expect(book.bids[1].id).toBe(2n);

    expect(book.asks).toHaveLength(2);
    expect(book.asks[0].id).toBe(3n);
    expect(book.asks[1].id).toBe(4n);
  });

  it("round-trips for capacity 128 with a sparse set of orders", () => {
    const bids = [order(10n, PublicKey.unique(), 500_000n, 1n, 1n)];
    const asks = [order(20n, PublicKey.unique(), 510_000n, 2n, 2n)];
    const raw = encodeBookForTest({ capacity: 128, bids, asks });

    const book = decodeBook(raw);
    expect(book.header.capacity).toBe(128);
    expect(book.bids).toHaveLength(1);
    expect(book.asks).toHaveLength(1);
  });

  it("skips empty slots (id === 0)", () => {
    const raw = encodeBookForTest({ capacity: 4, bids: [order(1n, PublicKey.unique(), 100n, 1n, 1n)] });
    const book = decodeBook(raw);
    expect(book.bids).toHaveLength(1);
    expect(book.asks).toHaveLength(0);
  });

  it("throws on a wrong discriminator", () => {
    const raw = encodeBookForTest({ capacity: 4 });
    raw[0] = "X".charCodeAt(0);
    expect(() => decodeBook(raw)).toThrow();
  });

  it("throws on a wrong length", () => {
    const raw = encodeBookForTest({ capacity: 4 });
    const truncated = raw.slice(0, raw.length - 1);
    expect(() => decodeBook(truncated)).toThrow();
  });

  it("throws when bidCount/askCount exceed capacity", () => {
    const raw = encodeBookForTest({ capacity: 4, bids: [order(1n, PublicKey.unique(), 100n, 1n, 1n)] });
    const view = new DataView(raw.buffer);
    // headerOffset(8) + bidCount offset(114).
    view.setUint16(8 + 114, 5, true);
    expect(() => decodeBook(raw)).toThrow(/bidCount/);
  });

  it("throws when a slot inside bidCount has id 0 (count/contents disagree)", () => {
    const raw = encodeBookForTest({
      capacity: 4,
      bids: [order(1n, PublicKey.unique(), 100n, 1n, 1n), order(2n, PublicKey.unique(), 90n, 1n, 2n)],
    });
    const view = new DataView(raw.buffer);
    const bodyOffset = 8 + 120;
    // Zero out the id of the second bid slot (index 1), which is inside bidCount (2).
    view.setBigUint64(bodyOffset + 1 * 64, 0n, true);
    expect(() => decodeBook(raw)).toThrow(/inside count/);
  });

  it("throws when a slot beyond bidCount has a nonzero id (count/contents disagree)", () => {
    const raw = encodeBookForTest({ capacity: 4, bids: [order(1n, PublicKey.unique(), 100n, 1n, 1n)] });
    const view = new DataView(raw.buffer);
    const bodyOffset = 8 + 120;
    // Slot index 1 is beyond bidCount (1); give it a nonzero id directly.
    view.setBigUint64(bodyOffset + 1 * 64, 7n, true);
    expect(() => decodeBook(raw)).toThrow(/beyond count/);
  });
});

describe("bestBid / bestAsk", () => {
  it("return the first stored order per side, undefined when empty", () => {
    const bids = [order(1n, PublicKey.unique(), 600_000n, 10n, 1n)];
    const asks = [order(2n, PublicKey.unique(), 650_000n, 10n, 2n)];
    const book = decodeBook(encodeBookForTest({ capacity: 8, bids, asks }));

    expect(bestBid(book)?.price).toBe(600_000n);
    expect(bestAsk(book)?.price).toBe(650_000n);

    const empty = decodeBook(encodeBookForTest({ capacity: 8 }));
    expect(bestBid(empty)).toBeUndefined();
    expect(bestAsk(empty)).toBeUndefined();
  });
});

describe("depth", () => {
  it("aggregates remaining quantity by price level, capped at `levels`", () => {
    const owner = PublicKey.unique();
    const bids = [
      order(1n, owner, 600_000n, 5n, 1n),
      order(2n, owner, 600_000n, 3n, 2n),
      order(3n, owner, 590_000n, 2n, 3n),
    ];
    const asks = [order(4n, owner, 610_000n, 4n, 4n)];
    const book = decodeBook(encodeBookForTest({ capacity: 8, bids, asks }));

    const d = depth(book, 1);
    expect(d.bids).toEqual([{ price: 600_000n, qty: 8n }]);
    expect(d.asks).toEqual([{ price: 610_000n, qty: 4n }]);

    const d2 = depth(book, 10);
    expect(d2.bids).toEqual([
      { price: 600_000n, qty: 8n },
      { price: 590_000n, qty: 2n },
    ]);
  });
});

describe("plannedFills", () => {
  it("takes asks price-ascending for a bid taker, up to qty", () => {
    const maker1 = PublicKey.unique();
    const maker2 = PublicKey.unique();
    const asks = [order(1n, maker1, 600_000n, 3n, 1n), order(2n, maker2, 610_000n, 10n, 2n)];
    const book = decodeBook(encodeBookForTest({ capacity: 8, asks }));

    const { fills, remaining } = plannedFills(book, "bid", 999_999n, 5n);
    expect(fills).toEqual([
      { makerOrderId: 1n, maker: maker1, price: 600_000n, qty: 3n },
      { makerOrderId: 2n, maker: maker2, price: 610_000n, qty: 2n },
    ]);
    expect(remaining).toBe(0n);
  });

  it("takes bids price-descending for an ask taker", () => {
    const maker1 = PublicKey.unique();
    const bids = [order(1n, maker1, 600_000n, 10n, 1n)];
    const book = decodeBook(encodeBookForTest({ capacity: 8, bids }));

    const { fills, remaining } = plannedFills(book, "ask", 1n, 3n);
    expect(fills).toEqual([{ makerOrderId: 1n, maker: maker1, price: 600_000n, qty: 3n }]);
    expect(remaining).toBe(0n);
  });

  it("stops at the limit price", () => {
    const asks = [order(1n, PublicKey.unique(), 600_000n, 10n, 1n), order(2n, PublicKey.unique(), 700_000n, 10n, 2n)];
    const book = decodeBook(encodeBookForTest({ capacity: 8, asks }));

    const { fills, remaining } = plannedFills(book, "bid", 650_000n, 20n);
    expect(fills).toHaveLength(1);
    expect(fills[0].price).toBe(600_000n);
    expect(remaining).toBe(10n);
  });

  it("caps at maxFills (8 by default)", () => {
    const asks: Order[] = [];
    for (let i = 0; i < 10; i += 1) {
      asks.push(order(BigInt(i + 1), PublicKey.unique(), BigInt(500_000 + i), 1n, BigInt(i + 1)));
    }
    const book = decodeBook(encodeBookForTest({ capacity: 16, asks }));

    const { fills, remaining } = plannedFills(book, "bid", 999_999n, 100n);
    expect(fills).toHaveLength(8);
    expect(remaining).toBe(92n);
  });

  it("returns no fills and full remaining against an empty book", () => {
    const book = decodeBook(encodeBookForTest({ capacity: 8 }));
    const { fills, remaining } = plannedFills(book, "bid", 999_999n, 5n);
    expect(fills).toEqual([]);
    expect(remaining).toBe(5n);
  });

  it("throws if maxFills is requested above the program's hard cap of 8", () => {
    const book = decodeBook(encodeBookForTest({ capacity: 8 }));
    expect(() => plannedFills(book, "bid", 999_999n, 5n, 9)).toThrow(/exceeds/);
  });
});
