import { describe, expect, it } from "vitest";
import type { MicroUsd } from "@meridian/sdk";
import { strikeLadder } from "@meridian/sdk";
import { atTheMoneyStrike, DEFAULT_PREV_CLOSE_USD, previousCloseMicroFor } from "../lib/lifecycle/prices.js";
import {
  EXPECTED_FINAL_PNL_MICRO_USDC,
  formatLifecycleReport,
  netTradingDeltas,
  selectAtTheMoneyStrike,
  simulateTradePlan,
  TRADE_1_BUY_YES,
  TRADE_2_BUY_NO,
  TRADE_3_SELL_YES,
  TRADE_4_SELL_NO,
  usdcForFill,
} from "../lib/lifecycle/trading-math.js";

describe("usdcForFill", () => {
  it("is price * qty with no further scaling", () => {
    expect(usdcForFill(600_000n, 3n)).toBe(1_800_000n);
    expect(usdcForFill(400_000n, 5n)).toBe(2_000_000n);
  });
});

describe("previousCloseMicroFor / atTheMoneyStrike (fixed table + strike selection)", () => {
  it("uses the fixed fallback table for AAPL", () => {
    expect(previousCloseMicroFor("AAPL")).toBe(333_000_000n);
  });

  it("prefers a given on-chain mock price over the fallback table", () => {
    expect(previousCloseMicroFor("AAPL", 340_000_000n)).toBe(340_000_000n);
  });

  it("rejects a non-positive latest mock price", () => {
    expect(() => previousCloseMicroFor("AAPL", 0n)).toThrow();
  });

  it("AAPL's ATM strike rounds 333.00 down to 330.00", () => {
    expect(atTheMoneyStrike(333_000_000n)).toBe(330_000_000n);
  });

  it("every fixed-table ticker's ATM strike is a member of its own ladder", () => {
    for (const [ticker, usd] of Object.entries(DEFAULT_PREV_CLOSE_USD)) {
      const prevClose = BigInt(usd) * 1_000_000n;
      const ladder = strikeLadder(prevClose as MicroUsd);
      const atm = atTheMoneyStrike(prevClose);
      expect(ladder).toContain(atm);
    }
  });
});

describe("selectAtTheMoneyStrike", () => {
  it("returns the ladder member equal to the candidate", () => {
    const ladder = strikeLadder(333_000_000n as MicroUsd);
    expect(selectAtTheMoneyStrike(ladder, 330_000_000n as MicroUsd)).toBe(330_000_000n);
  });

  it("throws if the candidate isn't in the ladder", () => {
    const ladder = strikeLadder(333_000_000n as MicroUsd);
    expect(() => selectAtTheMoneyStrike(ladder, 1n as MicroUsd)).toThrow();
  });
});

describe("hand-computed trade deltas (step 6)", () => {
  it("Trade 1 (Buy Yes market, 3 @ 0.60): taker -1.80 USDC +3 Yes; maker +1.80 USDC", () => {
    expect(TRADE_1_BUY_YES.taker).toEqual({ usdcMicro: -1_800_000n, yesWhole: 3n, noWhole: 0n });
    expect(TRADE_1_BUY_YES.maker).toEqual({ usdcMicro: 1_800_000n, yesWhole: 0n, noWhole: 0n });
  });

  it("Trade 2 (Buy No market, 4 @ 0.40): taker -2.40 USDC net +4 No; maker +4 Yes", () => {
    expect(TRADE_2_BUY_NO.taker).toEqual({ usdcMicro: -2_400_000n, yesWhole: 0n, noWhole: 4n });
    expect(TRADE_2_BUY_NO.maker).toEqual({ usdcMicro: 0n, yesWhole: 4n, noWhole: 0n });
  });

  it("Trade 3 (Sell Yes market, 1 @ 0.40): taker +0.40 USDC -1 Yes; maker +1 Yes", () => {
    expect(TRADE_3_SELL_YES.taker).toEqual({ usdcMicro: 400_000n, yesWhole: -1n, noWhole: 0n });
    expect(TRADE_3_SELL_YES.maker).toEqual({ usdcMicro: 0n, yesWhole: 1n, noWhole: 0n });
  });

  it("Trade 4 (Sell No market, 2 @ 0.60): taker +0.80 USDC net -2 No; maker +1.20 USDC", () => {
    expect(TRADE_4_SELL_NO.taker).toEqual({ usdcMicro: 800_000n, yesWhole: 0n, noWhole: -2n });
    expect(TRADE_4_SELL_NO.maker).toEqual({ usdcMicro: 1_200_000n, yesWhole: 0n, noWhole: 0n });
  });

  it("net trading deltas sum to -3.00 USDC for the taker and +3.00 USDC for the maker", () => {
    const { taker, maker } = netTradingDeltas();
    expect(taker.usdcMicro).toBe(-3_000_000n);
    expect(maker.usdcMicro).toBe(3_000_000n);
    // Zero-sum between the two users (no third party moves USDC in these four trades).
    expect(taker.usdcMicro + maker.usdcMicro).toBe(0n);
  });
});

describe("simulateTradePlan (fix #12: programmatic re-derivation of the hand-computed trades)", () => {
  it("matches TRADE_1..4 exactly, re-derived independently from the quotes/orders in TRADE_PLAN", () => {
    const [t1, t2, t3, t4] = simulateTradePlan();
    expect(t1).toEqual(TRADE_1_BUY_YES);
    expect(t2).toEqual(TRADE_2_BUY_NO);
    expect(t3).toEqual(TRADE_3_SELL_YES);
    expect(t4).toEqual(TRADE_4_SELL_NO);
  });

  it("the 0.60 ask is fully consumed (3 + 2 = 5 units, Trade 1 + Trade 4)", () => {
    const [t1, , , t4] = simulateTradePlan();
    const trade1AskUnits = t1.taker.yesWhole; // Trade 1 fills 3 against the 0.60 ask
    const trade4AskUnits = t4.maker.usdcMicro / 600_000n; // Trade 4's maker leg is 2 * 0.60
    expect(trade1AskUnits + trade4AskUnits).toBe(5n);
  });
});

describe("EXPECTED_FINAL_PNL_MICRO_USDC", () => {
  it("is zero-sum: maker's gain equals taker's loss", () => {
    expect(EXPECTED_FINAL_PNL_MICRO_USDC.maker + EXPECTED_FINAL_PNL_MICRO_USDC.taker).toBe(0n);
    expect(EXPECTED_FINAL_PNL_MICRO_USDC.maker).toBe(1_000_000n);
    expect(EXPECTED_FINAL_PNL_MICRO_USDC.taker).toBe(-1_000_000n);
  });
});

describe("formatLifecycleReport", () => {
  const sample = {
    cluster: "localnet" as const,
    programId: "Prog11111111111111111111111111111111111111",
    configAddress: "Conf11111111111111111111111111111111111111",
    tradingDay: 20261008,
    tickers: ["AAPL"] as import("@meridian/sdk").Ticker[],
    markets: [
      { ticker: "AAPL" as const, strike: 330_000_000n, market: "Mkt11111111111111111111111111111111111111", state: "Settled", outcome: "Yes" },
    ],
    rentSolPerMarket: 0.012345,
    rentSolTotal: 0.012345,
    userA: { address: "AAAA1111111111111111111111111111111111111", initialUsdcMicro: 1_000_000_000n, finalUsdcMicro: 1_001_000_000n },
    userB: { address: "BBBB1111111111111111111111111111111111111", initialUsdcMicro: 1_000_000_000n, finalUsdcMicro: 999_000_000n },
    vaultFinalMicro: 0n,
    wallClockMs: 12_345,
  };

  it("includes the program id, config PDA, market table, rent, and USDC flows", () => {
    const text = formatLifecycleReport(sample);
    expect(text).toContain(sample.programId);
    expect(text).toContain(sample.configAddress);
    expect(text).toContain("AAPL");
    expect(text).toContain("Settled");
    expect(text).toContain("outcome=Yes");
    expect(text).toContain("1000.000000 -> 1001.000000");
    expect(text).toContain("+1.000000");
    expect(text).toContain("-1.000000");
    expect(text).toContain("12.3s");
  });
});
