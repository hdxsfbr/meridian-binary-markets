import { describe, expect, it } from "vitest";
import { closeTsForDay, countOpen, earliestCloseTs, groupByTicker, todayTradingDay } from "./markets";

describe("groupByTicker", () => {
  it("groups items by key, preserving order", () => {
    const items = [
      { ticker: "META", strike: 1n },
      { ticker: "AAPL", strike: 2n },
      { ticker: "META", strike: 3n },
    ];
    const groups = groupByTicker(items, (i) => i.ticker);
    expect(Array.from(groups.keys())).toEqual(["META", "AAPL"]);
    expect(groups.get("META")).toEqual([
      { ticker: "META", strike: 1n },
      { ticker: "META", strike: 3n },
    ]);
    expect(groups.get("AAPL")).toEqual([{ ticker: "AAPL", strike: 2n }]);
  });

  it("returns an empty map for no items", () => {
    expect(groupByTicker([], (i: never) => String(i)).size).toBe(0);
  });
});

describe("countOpen", () => {
  it("counts only items for which the predicate is true", () => {
    const items = [{ state: "open" }, { state: "settled" }, { state: "open" }];
    expect(countOpen(items, (i) => i.state === "open")).toBe(2);
  });

  it("returns 0 for no open items", () => {
    expect(countOpen([{ state: "settled" }], (i) => i.state === "open")).toBe(0);
  });
});

describe("earliestCloseTs", () => {
  it("returns the minimum closeTs among open items only", () => {
    const items = [
      { state: "open", closeTs: 200n },
      { state: "settled", closeTs: 50n },
      { state: "open", closeTs: 100n },
    ];
    const result = earliestCloseTs(
      items,
      (i) => i.state === "open",
      (i) => i.closeTs,
    );
    expect(result).toBe(100);
  });

  it("returns undefined when there are no open items", () => {
    const items = [{ state: "settled", closeTs: 50n }];
    const result = earliestCloseTs(
      items,
      (i) => i.state === "open",
      (i) => i.closeTs,
    );
    expect(result).toBeUndefined();
  });
});

describe("todayTradingDay", () => {
  it("reads the trading day from the given zone, not UTC (July, EDT)", () => {
    // 2025-07-15T03:30:00Z is 2025-07-14T23:30:00 in America/New_York (EDT, UTC-4).
    const ms = Date.UTC(2025, 6, 15, 3, 30, 0);
    expect(todayTradingDay(ms, "America/New_York")).toBe(20250714);
  });

  it("rolls over to the next day once local time passes midnight (July, EDT)", () => {
    // 2025-07-15T05:00:00Z is 2025-07-15T01:00:00 in America/New_York (EDT, UTC-4).
    const ms = Date.UTC(2025, 6, 15, 5, 0, 0);
    expect(todayTradingDay(ms, "America/New_York")).toBe(20250715);
  });

  it("reads the trading day from the given zone, not UTC (December, EST)", () => {
    // 2025-12-15T04:30:00Z is 2025-12-14T23:30:00 in America/New_York (EST, UTC-5).
    const ms = Date.UTC(2025, 11, 15, 4, 30, 0);
    expect(todayTradingDay(ms, "America/New_York")).toBe(20251214);
  });

  it("defaults to the current instant when no argument is given", () => {
    const result = todayTradingDay();
    expect(result).toBeGreaterThan(20200101);
    expect(result).toBeLessThan(21000101);
  });
});

describe("closeTsForDay", () => {
  it("is 20:00 UTC for a July trading day (16:00 EDT, UTC-4)", () => {
    const expected = Date.UTC(2025, 6, 15, 20, 0, 0) / 1000;
    expect(closeTsForDay(20250715, "America/New_York")).toBe(expected);
  });

  it("is 21:00 UTC for a December trading day (16:00 EST, UTC-5)", () => {
    const expected = Date.UTC(2025, 11, 15, 21, 0, 0) / 1000;
    expect(closeTsForDay(20251215, "America/New_York")).toBe(expected);
  });

  it("round-trips with todayTradingDay: the close time's local trading day matches", () => {
    const day = 20250901;
    const closeTs = closeTsForDay(day, "America/New_York");
    expect(todayTradingDay(closeTs * 1000, "America/New_York")).toBe(day);
  });

  it("lands on 16:00:00 local wall-clock time in both July and December", () => {
    const julyMs = closeTsForDay(20250715, "America/New_York") * 1000;
    const decemberMs = closeTsForDay(20251215, "America/New_York") * 1000;
    const julyLocal = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(julyMs);
    const decemberLocal = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(decemberMs);
    expect(julyLocal).toBe("16:00");
    expect(decemberLocal).toBe("16:00");
  });
});
