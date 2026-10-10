import { describe, expect, it } from "vitest";
import { round10, STRIKE_OFFSETS_BPS, strikeLadder, strikeStepFor } from "../src/strikes";

const DOLLAR = 1_000_000n;
const dollars = (n: number): bigint => BigInt(n) * DOLLAR;

describe("STRIKE_OFFSETS_BPS", () => {
  it("is 3%, 6%, 9% in basis points", () => {
    expect(STRIKE_OFFSETS_BPS).toEqual([300, 600, 900]);
  });
});

describe("strikeStepFor", () => {
  it("is $10 for prices under $5,000", () => {
    expect(strikeStepFor(dollars(1))).toBe(dollars(10));
    expect(strikeStepFor(dollars(680))).toBe(dollars(10));
    expect(strikeStepFor(dollars(4_999))).toBe(dollars(10));
  });

  it("is $100 for prices from $5,000 up to (but not including) $50,000", () => {
    expect(strikeStepFor(dollars(5_000))).toBe(dollars(100));
    expect(strikeStepFor(dollars(12_345))).toBe(dollars(100));
    expect(strikeStepFor(dollars(49_999))).toBe(dollars(100));
  });

  it("is $500 for prices at or above $50,000", () => {
    expect(strikeStepFor(dollars(50_000))).toBe(dollars(500));
    expect(strikeStepFor(dollars(100_000))).toBe(dollars(500));
    expect(strikeStepFor(dollars(1_000_000))).toBe(dollars(500));
  });

  it("throws on a non-bigint input", () => {
    // @ts-expect-error -- deliberately wrong type for the runtime check.
    expect(() => strikeStepFor(100)).toThrow();
  });
});

describe("round10", () => {
  it("rounds to the nearest $10", () => {
    expect(round10(dollars(681))).toBe(dollars(680));
    expect(round10(dollars(686))).toBe(dollars(690));
  });

  it("rounds an exact half up", () => {
    // $685 is exactly halfway between $680 and $690.
    expect(round10(dollars(685))).toBe(dollars(690));
  });

  it("rounds just under a half down", () => {
    // $684.99 is just below the halfway point, so it rounds down to $680.
    expect(round10(684_990_000n)).toBe(dollars(680));
  });

  it("leaves an exact multiple of $10 unchanged", () => {
    expect(round10(dollars(680))).toBe(dollars(680));
  });

  it("rounds to a passed-in step other than $10", () => {
    // $100 step: $97,000 is exact, $97,060 rounds down, $97,250 is exact
    // half and rounds up.
    expect(round10(dollars(97_000), dollars(100))).toBe(dollars(97_000));
    expect(round10(dollars(97_060), dollars(100))).toBe(dollars(97_100));
    expect(round10(dollars(97_150), dollars(500))).toBe(dollars(97_000));
    expect(round10(dollars(97_250), dollars(500))).toBe(dollars(97_500));
  });

  it("throws on a non-positive step", () => {
    expect(() => round10(dollars(100), 0n)).toThrow();
    expect(() => round10(dollars(100), -dollars(10))).toThrow();
  });
});

describe("strikeLadder", () => {
  it("META prev close $680 -> seven unique strikes $620..$740", () => {
    const ladder = strikeLadder(dollars(680));
    expect(ladder).toEqual([
      dollars(620),
      dollars(640),
      dollars(660),
      dollars(680),
      dollars(700),
      dollars(720),
      dollars(740),
    ]);
  });

  it("AAPL prev close $230 -> five unique strikes after dedup", () => {
    const ladder = strikeLadder(dollars(230));
    expect(ladder).toEqual([dollars(210), dollars(220), dollars(230), dollars(240), dollars(250)]);
  });

  it("a low-priced ticker ($45) collapses to a small deduplicated set with no duplicates and no non-positive strikes", () => {
    const ladder = strikeLadder(dollars(45));
    expect(ladder).toEqual([dollars(40), dollars(50)]);
    expect(new Set(ladder).size).toBe(ladder.length);
    for (const strike of ladder) {
      expect(strike > 0n).toBe(true);
    }
  });

  it("excludes non-positive candidates rather than producing a $0 or negative strike", () => {
    // $4 previous close: every offset rounds to $0, which must be dropped
    // rather than appearing as a strike.
    const ladder = strikeLadder(dollars(4));
    for (const strike of ladder) {
      expect(strike > 0n).toBe(true);
    }
  });

  it("BTC-like prev close $100,000 -> seven strikes on the $500 grid (DECISIONS.md §30)", () => {
    const ladder = strikeLadder(dollars(100_000));
    expect(ladder).toEqual([
      dollars(91_000),
      dollars(94_000),
      dollars(97_000),
      dollars(100_000),
      dollars(103_000),
      dollars(106_000),
      dollars(109_000),
    ]);
    for (const strike of ladder) {
      expect(strike % dollars(500)).toBe(0n);
    }
  });

  it("a mid-magnitude prev close ($12,345) lands on the $100 grid", () => {
    const ladder = strikeLadder(dollars(12_345));
    for (const strike of ladder) {
      expect(strike % dollars(100)).toBe(0n);
    }
    // At-the-money candidate: 12345 rounded to the nearest $100 is 12300.
    expect(ladder).toContain(dollars(12_300));
  });

  it("throws on a non-positive prevCloseMicro", () => {
    expect(() => strikeLadder(0n)).toThrow();
    expect(() => strikeLadder(-dollars(100))).toThrow();
  });

  it("every strike is a multiple of $10 (10_000_000n micro-USD), sorted and unique, for 200 seeded random inputs between $10 and $2000", () => {
    // Deterministic PRNG (mulberry32) seeded for reproducibility; no new
    // dependency, just a small inline generator.
    let state = 0x2a17_f00d;
    const next = (): number => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let i = 0; i < 200; i += 1) {
      // A random micro-USD price between $10 and $2000, with sub-dollar
      // jitter so inputs aren't all exact dollars.
      const dollarsPart = 10 + Math.floor(next() * (2000 - 10));
      const microJitter = Math.floor(next() * 1_000_000);
      const prevCloseMicro = dollars(dollarsPart) + BigInt(microJitter);

      const ladder = strikeLadder(prevCloseMicro);

      // Unique.
      expect(new Set(ladder).size).toBe(ladder.length);

      // Sorted ascending.
      for (let j = 1; j < ladder.length; j += 1) {
        expect(ladder[j] > ladder[j - 1]).toBe(true);
      }

      // All positive multiples of $10.
      for (const strike of ladder) {
        expect(strike > 0n).toBe(true);
        expect(strike % 10_000_000n).toBe(0n);
      }
    }
  });
});
