import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_POINTS, _resetAllForTest, getHistory, getSeedAt, mergeSeed, push, setSeedAt } from "./price-history";

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

  describe("mergeSeed", () => {
    it("merges a remote seed into an empty buffer, sorted ascending", () => {
      const result = mergeSeed("AAPL", [
        { ts: 200, priceMicro: "340000000" },
        { ts: 100, priceMicro: "339000000" },
      ]);
      expect(result).toEqual([
        { priceMicro: 339_000_000n, ts: 100 },
        { priceMicro: 340_000_000n, ts: 200 },
      ]);
      expect(getHistory("AAPL")).toEqual(result);
    });

    it("merges a remote seed with existing live samples, deduping by ts (overlay wins)", () => {
      push("AAPL", 1n, 100);
      push("AAPL", 2n, 300);
      const result = mergeSeed("AAPL", [
        { ts: 100, priceMicro: "99" },
        { ts: 200, priceMicro: "5" },
      ]);
      expect(result).toEqual([
        { priceMicro: 99n, ts: 100 },
        { priceMicro: 5n, ts: 200 },
        { priceMicro: 2n, ts: 300 },
      ]);
    });

    it("caps the merged result at MAX_POINTS, dropping the oldest", () => {
      const remote = Array.from({ length: MAX_POINTS + 10 }, (_, i) => ({ ts: i, priceMicro: String(i) }));
      const result = mergeSeed("AAPL", remote);
      expect(result).toHaveLength(MAX_POINTS);
      expect(result[0].ts).toBe(10);
      expect(result[result.length - 1].ts).toBe(MAX_POINTS + 9);
    });
  });

  describe("seed timestamp", () => {
    it("is undefined until set", () => {
      expect(getSeedAt("AAPL")).toBeUndefined();
    });

    it("round-trips through setSeedAt/getSeedAt", () => {
      setSeedAt("AAPL", 12_345);
      expect(getSeedAt("AAPL")).toBe(12_345);
    });

    it("is tracked separately per ticker", () => {
      setSeedAt("AAPL", 1);
      setSeedAt("MSFT", 2);
      expect(getSeedAt("AAPL")).toBe(1);
      expect(getSeedAt("MSFT")).toBe(2);
    });
  });
});

type PricePointMutable = { priceMicro: bigint; ts: number };
