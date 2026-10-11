import { describe, expect, it } from "vitest";
import { formatLatencySummary, summarizeLatencies } from "../lib/lifecycle/latency.js";

describe("summarizeLatencies", () => {
  it("rejects an empty list rather than returning a misleading zero summary", () => {
    expect(() => summarizeLatencies([])).toThrow();
  });

  it("every field equals the single value for a one-element list", () => {
    expect(summarizeLatencies([500])).toEqual({ count: 1, medianMs: 500, p95Ms: 500, maxMs: 500 });
  });

  it("median is the middle value for an odd-length list, independent of input order", () => {
    expect(summarizeLatencies([300, 100, 200]).medianMs).toBe(200);
  });

  it("median is the average of the two middle values for an even-length list", () => {
    expect(summarizeLatencies([100, 200, 300, 400]).medianMs).toBe(250);
  });

  it("max is the largest value regardless of input order", () => {
    expect(summarizeLatencies([400, 100, 900, 200]).maxMs).toBe(900);
  });

  it("count matches the input length", () => {
    expect(summarizeLatencies([1, 2, 3, 4, 5]).count).toBe(5);
  });

  it("p95 of 1..100 (linear-interpolation convention) is 95.05", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(summarizeLatencies(values).p95Ms).toBeCloseTo(95.05, 5);
  });

  it("p95 never exceeds the max", () => {
    const summary = summarizeLatencies([10, 20, 30, 1000]);
    expect(summary.p95Ms).toBeLessThanOrEqual(summary.maxMs);
  });

  it("does not mutate the input array (sorts a copy)", () => {
    const input = [300, 100, 200];
    summarizeLatencies(input);
    expect(input).toEqual([300, 100, 200]);
  });
});

describe("formatLatencySummary", () => {
  it("renders count/median/p95/max rounded to whole milliseconds", () => {
    expect(formatLatencySummary({ count: 42, medianMs: 410.4, p95Ms: 980.6, maxMs: 1240 })).toBe(
      "count=42 median=410ms p95=981ms max=1240ms",
    );
  });
});
