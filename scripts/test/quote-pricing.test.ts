import { describe, expect, it } from "vitest";
import { nearestStrike, normalCdf, planQuote } from "../lib/quote-pricing.js";

describe("normalCdf", () => {
  it("is 0.5 at zero and symmetric", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1) + normalCdf(-1)).toBeCloseTo(1, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
});

describe("planQuote", () => {
  it("quotes around 50 cents when the price sits on the strike, 3 cents each side", () => {
    const q = planQuote(230, 230);
    expect(q.probability).toBeCloseTo(0.5, 6);
    expect(q.bidMicro).toBe(470_000n);
    expect(q.askMicro).toBe(530_000n);
  });
  it("prices Yes high when the stock is well above the strike and low when well below", () => {
    expect(planQuote(240, 230).probability).toBeGreaterThan(0.99);
    expect(planQuote(220, 230).probability).toBeLessThan(0.01);
  });
  it("clamps to the 5-95 cent band and never crosses", () => {
    const high = planQuote(240, 230);
    expect(high.bidMicro).toBe(940_000n);
    expect(high.askMicro).toBe(950_000n);
    const low = planQuote(220, 230);
    expect(low.bidMicro).toBe(50_000n);
    expect(low.askMicro).toBe(60_000n);
    expect(high.askMicro).toBeGreaterThan(high.bidMicro);
  });
  it("rejects non-positive inputs", () => {
    expect(() => planQuote(0, 230)).toThrow();
  });
});

describe("nearestStrike", () => {
  it("picks the closest strike, lower one on a tie", () => {
    expect(nearestStrike(233, [220, 230, 240])).toBe(230);
    expect(nearestStrike(235, [220, 230, 240])).toBe(230);
    expect(nearestStrike(236, [220, 230, 240])).toBe(240);
    expect(nearestStrike(1, [])).toBeUndefined();
  });
});
