import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_POINTS, _resetAllForTest, getHistory, push } from "./price-history";

describe("price-history", () => {
  beforeEach(() => {
    _resetAllForTest();
  });

  it("starts empty for a ticker with no samples", () => {
    expect(getHistory("AAPL")).toEqual([]);
  });

  it("records a pushed point", () => {
    const result = push("AAPL", 340_000_000n, 100);
    expect(result).toEqual([{ priceMicro: 340_000_000n, ts: 100 }]);
    expect(getHistory("AAPL")).toEqual([{ priceMicro: 340_000_000n, ts: 100 }]);
  });

  it("dedupes an identical consecutive sample at the same timestamp", () => {
    push("AAPL", 340_000_000n, 100);
    const result = push("AAPL", 340_000_000n, 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ priceMicro: 340_000_000n, ts: 100 });
  });

  it("keeps a new point for an unchanged price at a newer timestamp (flat feed still draws a line)", () => {
    push("AAPL", 340_000_000n, 100);
    const result = push("AAPL", 340_000_000n, 101);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ priceMicro: 340_000_000n, ts: 101 });
  });

  it("keeps a new point when the price actually changes", () => {
    push("AAPL", 340_000_000n, 100);
    const result = push("AAPL", 341_000_000n, 101);
    expect(result).toHaveLength(2);
  });

  it("re-records a price after a different one came between (not deduped against a non-adjacent point)", () => {
    push("AAPL", 340_000_000n, 100);
    push("AAPL", 341_000_000n, 101);
    const result = push("AAPL", 340_000_000n, 102);
    expect(result).toHaveLength(3);
  });

  it("caps the buffer at MAX_POINTS, dropping the oldest first", () => {
    for (let i = 0; i < MAX_POINTS + 5; i += 1) {
      push("AAPL", BigInt(i), i);
    }
    const result = getHistory("AAPL");
    expect(result).toHaveLength(MAX_POINTS);
    expect(result[0]).toEqual({ priceMicro: 5n, ts: 5 });
    expect(result[result.length - 1]).toEqual({ priceMicro: BigInt(MAX_POINTS + 4), ts: MAX_POINTS + 4 });
  });

  it("keeps separate buffers per ticker", () => {
    push("AAPL", 1n, 1);
    push("MSFT", 2n, 1);
    push("MSFT", 3n, 2);
    expect(getHistory("AAPL")).toHaveLength(1);
    expect(getHistory("MSFT")).toHaveLength(2);
  });

  it("degrades to in-memory only when window.sessionStorage itself throws (SecurityError / blocked storage)", () => {
    const throwingWindow = {
      get sessionStorage(): Storage {
        throw new Error("SecurityError: sessionStorage is blocked");
      },
    };
    vi.stubGlobal("window", throwingWindow);
    try {
      const pushed = push("AAPL", 1n, 1);
      expect(pushed).toEqual([{ priceMicro: 1n, ts: 1 }]);
      expect(getHistory("AAPL")).toEqual([{ priceMicro: 1n, ts: 1 }]);
      const pushedAgain = push("AAPL", 2n, 2);
      expect(pushedAgain).toEqual([
        { priceMicro: 1n, ts: 1 },
        { priceMicro: 2n, ts: 2 },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getHistory returns a snapshot that mutation of the result can't corrupt", () => {
    push("AAPL", 1n, 1);
    const snapshot = getHistory("AAPL") as PricePointMutable[];
    snapshot.push({ priceMicro: 999n, ts: 999 });
    expect(getHistory("AAPL")).toHaveLength(1);
  });
});

type PricePointMutable = { priceMicro: bigint; ts: number };
