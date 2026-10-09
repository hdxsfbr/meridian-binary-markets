import { describe, expect, it } from "vitest";
import { dollarsToMicroString, mergeByTimestamp, parseUdfHistory } from "./price-history-remote";

describe("dollarsToMicroString", () => {
  it("scales a dollar price to micro-USD, rounding to the nearest micro-dollar", () => {
    expect(dollarsToMicroString(5)).toBe("5000000");
    expect(dollarsToMicroString(340.62)).toBe("340620000");
    expect(dollarsToMicroString(340.6199999)).toBe("340620000");
  });
});

describe("parseUdfHistory", () => {
  it("merges parallel t/c arrays into points, using close as the price", () => {
    const points = parseUdfHistory({ s: "ok", t: [100, 160, 220], c: [340.62, 340.5, 341.0] });
    expect(points).toEqual([
      { ts: 100, priceMicro: "340620000" },
      { ts: 160, priceMicro: "340500000" },
      { ts: 220, priceMicro: "341000000" },
    ]);
  });

  it("returns an empty series for s: 'no_data'", () => {
    expect(parseUdfHistory({ s: "no_data" })).toEqual([]);
  });

  it("returns an empty series for s: 'error'", () => {
    expect(parseUdfHistory({ s: "error", errmsg: "symbol not found" })).toEqual([]);
  });

  it("returns an empty series when t or c is missing or malformed", () => {
    expect(parseUdfHistory({ s: "ok" })).toEqual([]);
    expect(parseUdfHistory({ s: "ok", t: [100], c: undefined })).toEqual([]);
    expect(parseUdfHistory({ s: "ok", t: "nope" as unknown as number[], c: [1] })).toEqual([]);
  });

  it("skips individual bars whose t or c decoded as a non-finite number", () => {
    const points = parseUdfHistory({
      s: "ok",
      t: [100, 160, 220],
      c: [340.62, Number.NaN, 341.0],
    });
    expect(points).toEqual([
      { ts: 100, priceMicro: "340620000" },
      { ts: 220, priceMicro: "341000000" },
    ]);
  });

  it("truncates to the shorter of mismatched t/c array lengths", () => {
    const points = parseUdfHistory({ s: "ok", t: [100, 160, 220], c: [340.62, 340.5] });
    expect(points).toEqual([
      { ts: 100, priceMicro: "340620000" },
      { ts: 160, priceMicro: "340500000" },
    ]);
  });
});

describe("mergeByTimestamp", () => {
  it("merges and sorts two series ascending by ts", () => {
    const base = [{ ts: 100 }, { ts: 300 }];
    const overlay = [{ ts: 200 }];
    expect(mergeByTimestamp(base, overlay)).toEqual([{ ts: 100 }, { ts: 200 }, { ts: 300 }]);
  });

  it("dedupes a shared timestamp, overlay winning the tie", () => {
    const base = [{ ts: 100, v: "base" }];
    const overlay = [{ ts: 100, v: "overlay" }];
    expect(mergeByTimestamp(base, overlay)).toEqual([{ ts: 100, v: "overlay" }]);
  });

  it("handles an empty overlay or base", () => {
    expect(mergeByTimestamp([{ ts: 1 }], [])).toEqual([{ ts: 1 }]);
    expect(mergeByTimestamp([], [{ ts: 1 }])).toEqual([{ ts: 1 }]);
    expect(mergeByTimestamp([], [])).toEqual([]);
  });
});
