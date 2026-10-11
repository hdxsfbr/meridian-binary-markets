import { describe, expect, it } from "vitest";
import {
  confidenceLabel,
  formatDuration,
  formatEt,
  mergeStatus,
  oracleProviderLabel,
  overrideAvailability,
  overrideDelayLabel,
  publishOffsetLabel,
  settledByOverride,
  stalenessLabel,
  strikeAdjustability,
  strikeLockReasonLabel,
  unsettledAfterClose,
  validateNewStrike,
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

describe("strikeAdjustability", () => {
  // closeTs=2000, now=1000 keeps every one of these cases well before close,
  // so the pairs/book checks below are exercised independent of the
  // close-time lock (covered in its own cases further down).
  const OPEN_CLOSE_TS = 2000;
  const BEFORE_CLOSE_NOW = 1000;

  it("is adjustable when there are zero pairs outstanding and an empty book", () => {
    expect(strikeAdjustability(0n, 0, 0, OPEN_CLOSE_TS, BEFORE_CLOSE_NOW)).toEqual({ adjustable: true, reason: null });
  });

  it("is locked (minted) when any pairs are outstanding, even with an empty book", () => {
    expect(strikeAdjustability(1n, 0, 0, OPEN_CLOSE_TS, BEFORE_CLOSE_NOW)).toEqual({ adjustable: false, reason: "minted" });
  });

  it("is locked (orders) when the book has a resting bid, even with zero pairs outstanding", () => {
    expect(strikeAdjustability(0n, 1, 0, OPEN_CLOSE_TS, BEFORE_CLOSE_NOW)).toEqual({ adjustable: false, reason: "orders" });
  });

  it("is locked (orders) when the book has a resting ask", () => {
    expect(strikeAdjustability(0n, 0, 1, OPEN_CLOSE_TS, BEFORE_CLOSE_NOW)).toEqual({ adjustable: false, reason: "orders" });
  });

  it("prefers the 'minted' reason when both pairs are outstanding and the book is non-empty", () => {
    expect(strikeAdjustability(5n, 2, 3, OPEN_CLOSE_TS, BEFORE_CLOSE_NOW)).toEqual({ adjustable: false, reason: "minted" });
  });

  it("is still adjustable one second before close, with nothing minted and an empty book", () => {
    expect(strikeAdjustability(0n, 0, 0, 2000, 1999)).toEqual({ adjustable: true, reason: null });
  });

  it("is locked (closed) exactly at close_ts, even with nothing minted and an empty book", () => {
    expect(strikeAdjustability(0n, 0, 0, 2000, 2000)).toEqual({ adjustable: false, reason: "closed" });
  });

  it("is locked (closed) after close_ts", () => {
    expect(strikeAdjustability(0n, 0, 0, 2000, 2500)).toEqual({ adjustable: false, reason: "closed" });
  });

  it("prefers the 'closed' reason over 'minted'/'orders' once past close", () => {
    expect(strikeAdjustability(5n, 2, 3, 2000, 2000)).toEqual({ adjustable: false, reason: "closed" });
  });
});

describe("strikeLockReasonLabel", () => {
  it("describes 'minted' in plain language", () => {
    expect(strikeLockReasonLabel("minted")).toBe("Locked: contracts have been minted");
  });

  it("describes 'orders' in plain language", () => {
    expect(strikeLockReasonLabel("orders")).toBe("Locked: orders are on the book");
  });

  it("describes 'closed' in plain language", () => {
    expect(strikeLockReasonLabel("closed")).toBe("Locked: trading has closed for today");
  });

  it("never leaks implementation words", () => {
    const text = `${strikeLockReasonLabel("minted")} ${strikeLockReasonLabel("orders")} ${strikeLockReasonLabel("closed")}`;
    for (const banned of ["resting", "fill", "escrow", "mock", "devnet", "RPC", "PDA", "ATA", "bps", "staleness"]) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe("validateNewStrike", () => {
  it("rejects zero and negative strikes", () => {
    expect(validateNewStrike(0n, [])).toBe("Enter a strike greater than $0.");
    expect(validateNewStrike(-10_000_000n, [])).toBe("Enter a strike greater than $0.");
  });

  it("accepts a positive strike on the $10 grid (sub-$5,000 equities)", () => {
    expect(validateNewStrike(680_000_000n, [])).toBeNull();
  });

  it("rejects a strike off the $10 grid", () => {
    expect(validateNewStrike(685_500_000n, [])).toBe("Enter a strike on the $10 grid.");
  });

  it("rejects a strike that is already listed", () => {
    expect(validateNewStrike(680_000_000n, [680_000_000n, 690_000_000n])).toBe("That strike is already listed.");
  });

  it("accepts a strike not among the existing ones", () => {
    expect(validateNewStrike(700_000_000n, [680_000_000n, 690_000_000n])).toBeNull();
  });

  it("uses the $500 grid for a BTC-magnitude strike", () => {
    expect(validateNewStrike(97_000_000_000n, [])).toBeNull();
    expect(validateNewStrike(97_100_000_000n, [])).toBe("Enter a strike on the $500 grid.");
  });

  it("accepts a strike right at the $10,000,000 human cap", () => {
    expect(validateNewStrike(10_000_000n * 1_000_000n, [])).toBeNull();
  });

  it("rejects a strike above the $10,000,000 human cap", () => {
    expect(validateNewStrike(10_000_000n * 1_000_000n + 1_000_000n, [])).toBe("That strike is too large.");
  });

  it("rejects a strike above the on-chain u64 ceiling", () => {
    const u64Max = 18_446_744_073_709_551_615n;
    expect(validateNewStrike(u64Max + 1n, [])).toBe("That strike is too large.");
    expect(validateNewStrike(u64Max, [])).toBe("That strike is too large."); // still above the $10M human cap
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

describe("settlement check labels (Wave R5 copy audit)", () => {
  it("staleness: whole minutes render as minutes", () => {
    expect(stalenessLabel(300)).toBe("Price no older than 5 min");
  });

  it("staleness: non-whole minutes render as seconds", () => {
    expect(stalenessLabel(45)).toBe("Price no older than 45s");
  });

  it("confidence: basis points convert to a percent", () => {
    expect(confidenceLabel(25)).toBe("Confidence within 0.25%");
    expect(confidenceLabel(100)).toBe("Confidence within 1%");
  });

  it("publish offset: zero means at or after close", () => {
    expect(publishOffsetLabel(0)).toBe("Price published at or after close");
  });

  it("publish offset: nonzero means up to N seconds before close", () => {
    expect(publishOffsetLabel(60)).toBe("Price published up to 60s before close");
  });

  it("override delay: whole hours render as hours", () => {
    expect(overrideDelayLabel(3600)).toBe("Override allowed 1 h after close");
  });

  it("override delay: non-whole hours render as whole minutes", () => {
    expect(overrideDelayLabel(90)).toBe("Override allowed 90s after close");
    expect(overrideDelayLabel(120)).toBe("Override allowed 2 min after close");
  });

  it("oracle provider: plain-language price source", () => {
    expect(oracleProviderLabel({ mockPyth: {} })).toBe("Price source: test publisher");
    expect(oracleProviderLabel({ pythReceiver: {} })).toBe("Price source: Pyth");
    expect(oracleProviderLabel(undefined)).toBe("Price source: unknown");
  });
});
