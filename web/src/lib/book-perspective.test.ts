import { describe, expect, it } from "vitest";
import { bestAsk, bestBid, spread, toPerspective, type BookLevel } from "./book-perspective";

const bids: BookLevel[] = [
  { price: 600_000n, qty: 10n },
  { price: 650_000n, qty: 5n },
];
const asks: BookLevel[] = [
  { price: 700_000n, qty: 8n },
  { price: 750_000n, qty: 2n },
];

describe("toPerspective", () => {
  it("returns bids/asks sorted best-first for the yes perspective", () => {
    const view = toPerspective(bids, asks, "yes");
    expect(view.bids.map((l) => l.price)).toEqual([650_000n, 600_000n]);
    expect(view.asks.map((l) => l.price)).toEqual([700_000n, 750_000n]);
  });

  it("swaps sides and re-prices for the no perspective", () => {
    const view = toPerspective(bids, asks, "no");
    // Yes asks become No bids, re-priced via 1_000_000 - price.
    expect(view.bids.map((l) => l.price)).toEqual([300_000n, 250_000n]);
    expect(view.bids.map((l) => l.qty)).toEqual([8n, 2n]);
    // Yes bids become No asks, re-priced.
    expect(view.asks.map((l) => l.price)).toEqual([350_000n, 400_000n]);
    expect(view.asks.map((l) => l.qty)).toEqual([5n, 10n]);
  });

  it("does not mutate the inputs", () => {
    const bidsCopy = [...bids];
    const asksCopy = [...asks];
    toPerspective(bids, asks, "no");
    expect(bids).toEqual(bidsCopy);
    expect(asks).toEqual(asksCopy);
  });

  it("handles empty books", () => {
    const view = toPerspective([], [], "no");
    expect(view.bids).toEqual([]);
    expect(view.asks).toEqual([]);
  });
});

describe("bestBid / bestAsk", () => {
  it("picks the highest-priced bid", () => {
    expect(bestBid(bids)).toEqual({ price: 650_000n, qty: 5n });
  });

  it("picks the lowest-priced ask", () => {
    expect(bestAsk(asks)).toEqual({ price: 700_000n, qty: 8n });
  });

  it("is undefined for an empty side", () => {
    expect(bestBid([])).toBeUndefined();
    expect(bestAsk([])).toBeUndefined();
  });
});

describe("spread", () => {
  it("is best ask minus best bid", () => {
    expect(spread(bids, asks)).toBe(50_000n);
  });

  it("is undefined when a side is empty", () => {
    expect(spread([], asks)).toBeUndefined();
    expect(spread(bids, [])).toBeUndefined();
  });
});
