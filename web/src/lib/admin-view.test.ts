import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatEt,
  mergeStatus,
  overrideAvailability,
  settledByOverride,
  unsettledAfterClose,
  type StatusMap,
  type UnsettledMarket,
} from "./admin-view";

describe("unsettledAfterClose", () => {
  const base = { pubkey: "A", ticker: "AAPL", strike: 100_000_000n, closeTs: 1000, state: "open" as const };

  it("includes open markets whose closeTs has already passed", () => {
    const result = unsettledAfterClose([base], 1500);
    expect(result).toEqual([{ pubkey: "A", ticker: "AAPL", strike: 100_000_000n, closeTs: 1000, closedForSecs: 500 }]);
  });

  it("excludes open markets that have not yet closed", () => {
    expect(unsettledAfterClose([base], 500)).toEqual([]);
  });

  it("excludes settled markets regardless of closeTs", () => {
    expect(unsettledAfterClose([{ ...base, state: "settled" }], 1500)).toEqual([]);
  });

  it("treats closeTs == now as closed (closedForSecs 0)", () => {
    const result = unsettledAfterClose([base], 1000);
    expect(result[0]?.closedForSecs).toBe(0);
  });
});

describe("overrideAvailability", () => {
  it("is unavailable before close_ts + delay", () => {
    const a = overrideAvailability(1000, 3600, 4599);
    expect(a.available).toBe(false);
    expect(a.availableAt).toBe(4600);
    expect(a.secondsRemaining).toBe(1);
  });

  it("becomes available at exactly close_ts + delay", () => {
    const a = overrideAvailability(1000, 3600, 4600);
    expect(a.available).toBe(true);
    expect(a.secondsRemaining).toBe(0);
  });

  it("stays available well past the delay", () => {
    const a = overrideAvailability(1000, 3600, 10_000);
    expect(a.available).toBe(true);
    expect(a.secondsRemaining).toBe(0);
  });
});

describe("mergeStatus", () => {
  const market: UnsettledMarket = { pubkey: "A", ticker: "AAPL", strike: 100_000_000n, closeTs: 1000, closedForSecs: 10 };
  const entry = {
    ticker: "AAPL",
    strike: "100000000",
    attempts: 2,
    lastError: "OracleStale",
    lastAttemptAt: 1200,
    nextRetryAt: 1230,
    overrideAvailableAt: 4600,
    settled: false,
  };

  it("attaches the matching status entry by pubkey", () => {
    const statusMap: StatusMap = { A: entry };
    expect(mergeStatus([market], statusMap)).toEqual([{ ...market, status: entry }]);
  });

  it("leaves status undefined when the map has no entry for this market", () => {
    const statusMap: StatusMap = { OTHER: entry };
    expect(mergeStatus([market], statusMap)[0]?.status).toBeUndefined();
  });

  it("leaves status undefined for every market when the status map itself is null", () => {
    expect(mergeStatus([market], null)[0]?.status).toBeUndefined();
  });
});

describe("settledByOverride", () => {
  const settled = { pubkey: "A", ticker: "AAPL", strike: 1n, state: "settled" as const, settledByOverride: true };
  const settledNotOverride = { pubkey: "B", ticker: "MSFT", strike: 2n, state: "settled" as const, settledByOverride: false };
  const open = { pubkey: "C", ticker: "TSLA", strike: 3n, state: "open" as const, settledByOverride: false };

  it("keeps only settled markets with settledByOverride true", () => {
    expect(settledByOverride([settled, settledNotOverride, open])).toEqual([settled]);
  });

  it("returns an empty array when none qualify", () => {
    expect(settledByOverride([settledNotOverride, open])).toEqual([]);
  });
});

describe("formatEt", () => {
  it("formats a known instant in America/New_York with an ET suffix", () => {
    // 2026-10-06T20:00:30Z is 16:00:30 EDT (UTC-4) on that date.
    const unix = Math.floor(new Date("2026-10-06T20:00:30Z").getTime() / 1000);
    expect(formatEt(unix)).toBe("4:00:30 PM ET");
  });

  it("formats midnight-adjacent instants without throwing", () => {
    const unix = Math.floor(new Date("2026-01-01T05:00:00Z").getTime() / 1000);
    expect(formatEt(unix)).toMatch(/ET$/);
  });
});

describe("formatDuration", () => {
  it("formats under a minute as seconds", () => {
    expect(formatDuration(42)).toBe("42s");
  });

  it("formats minutes and padded seconds", () => {
    expect(formatDuration(305)).toBe("5m 05s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3 * 3600 + 12 * 60 + 5)).toBe("3h 12m");
  });

  it("clamps negative durations to 0", () => {
    expect(formatDuration(-5)).toBe("0s");
  });
});
