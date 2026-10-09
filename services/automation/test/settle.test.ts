import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { Ticker } from "@meridian/sdk";
import { runSettleJob, settlementStatus, __resetSettlementStatus, type SettleChain } from "../src/jobs/settle";
import type { MarketAccount, MarketRecord } from "../src/chain";
import type { PriceProvider } from "../src/providers/PriceProvider";
import { HermesError } from "../src/sources/hermes";

const MARKET_PUBKEY = new PublicKey("11111111111111111111111111111112");
const PRICE_ACCOUNT = new PublicKey("11111111111111111111111111111113");
const PRICE_ACCOUNT_2 = new PublicKey("11111111111111111111111111111114");

function marketRecord(overrides: Partial<MarketRecord["account"]> = {}): MarketRecord {
  return {
    publicKey: MARKET_PUBKEY,
    account: {
      ticker: "META" as Ticker,
      strike: 680_000_000n,
      tradingDay: 20261006,
      closeTs: 1_759_780_800,
      state: "Open",
      outcome: "Unset",
      settlementPrice: 0n,
      settledAt: 0,
      settledByOverride: false,
      yesMint: PublicKey.default,
      noMint: PublicKey.default,
      vault: PublicKey.default,
      book: PublicKey.default,
      bookCapacity: 128,
      pairsOutstanding: 0n,
      ...overrides,
    },
  };
}

/** Always reports `Open` -- the default for tests that don't care about fix #17 reconciliation. */
async function alwaysOpenFetchMarket(): Promise<Pick<MarketAccount, "state"> | null> {
  return { state: "Open" };
}

function fakeProvider(publishImpl: () => Promise<{ priceAccount: PublicKey; publishTime: number }>): PriceProvider {
  return {
    publish: publishImpl,
    async previousClose() {
      throw new Error("not used in settle job tests");
    },
    async currentPrice() {
      throw new Error("not used in settle job tests");
    },
  };
}

beforeEach(() => {
  __resetSettlementStatus();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runSettleJob", () => {
  it("retries a guard failure every 30s and alerts exactly once after 15 minutes", async () => {
    const record = marketRecord();
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        throw new Error("OracleStale");
      },
      fetchMarket: alwaysOpenFetchMarket,
    };
    const provider = fakeProvider(async () => ({ priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 }));
    const alertFn = vi.fn().mockResolvedValue(undefined);

    const runPromise = runSettleJob(
      { chain, provider, alertFn, alertWebhookUrl: "https://example.test/webhook" },
      { day: 20261006 },
    );

    // Advance past the 15-minute window in 30s steps.
    for (let i = 0; i < 31; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await runPromise;

    expect(alertFn).toHaveBeenCalledTimes(1);
    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.settled).toBe(false);
    expect(entry.attempts).toBeGreaterThan(1);
    expect(entry.nextRetryAt).toBeUndefined(); // fix #18: cleared on the alert (terminal) path
  });

  it("fix #4: classifies Hermes 401/403/429 as terminal -- alerts once immediately, no 30s retry", async () => {
    const record = marketRecord();
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        throw new Error("should never be reached: publish failed before any settleMarket call");
      },
      fetchMarket: alwaysOpenFetchMarket,
    };
    const provider = fakeProvider(async () => {
      throw new HermesError(403, "Not entitled: feed requires an upgraded plan");
    });
    const alertFn = vi.fn().mockResolvedValue(undefined);

    // Note: no `vi.advanceTimersByTimeAsync` loop here -- a terminal classification
    // must resolve the job immediately, without waiting out the 30s retry cadence or
    // the 15-minute alert window.
    await runSettleJob({ chain, provider, alertFn, alertWebhookUrl: "https://example.test/webhook" }, { day: 20261006 });

    expect(alertFn).toHaveBeenCalledTimes(1);
    const [alertInput] = alertFn.mock.calls[0] as [{ error: string }];
    expect(alertInput.error).toMatch(/HTTP 403/);
    expect(alertInput.error).toMatch(/entitlement/i);

    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.settled).toBe(false);
    expect(entry.attempts).toBe(1); // never retried
    expect(entry.nextRetryAt).toBeUndefined();
  });

  it("keeps retrying a non-Hermes publish failure on the normal 30s/15min cadence", async () => {
    const record = marketRecord();
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        throw new Error("should never be reached: publish failed before any settleMarket call");
      },
      fetchMarket: alwaysOpenFetchMarket,
    };
    const provider = fakeProvider(async () => {
      throw new Error("RPC timeout");
    });
    const alertFn = vi.fn().mockResolvedValue(undefined);

    const runPromise = runSettleJob(
      { chain, provider, alertFn, alertWebhookUrl: "https://example.test/webhook" },
      { day: 20261006 },
    );

    for (let i = 0; i < 31; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await runPromise;

    expect(alertFn).toHaveBeenCalledTimes(1);
    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.attempts).toBeGreaterThan(1); // retried, unlike the Hermes-terminal case above
  });

  it("treats AlreadySettled as success with no alert", async () => {
    const record = marketRecord();
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        throw { error: { errorCode: { code: "AlreadySettled" } } };
      },
      fetchMarket: alwaysOpenFetchMarket,
    };
    const provider = fakeProvider(async () => ({ priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 }));
    const alertFn = vi.fn().mockResolvedValue(undefined);

    await runSettleJob({ chain, provider, alertFn, alertWebhookUrl: "https://example.test/webhook" }, { day: 20261006 });

    expect(alertFn).not.toHaveBeenCalled();
    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.settled).toBe(true);
  });

  it("succeeds on the third attempt with no alert", async () => {
    let attempts = 0;
    const record = marketRecord();
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        attempts += 1;
        if (attempts < 3) throw new Error("OracleStale");
      },
      fetchMarket: alwaysOpenFetchMarket,
    };
    const provider = fakeProvider(async () => ({ priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 }));
    const alertFn = vi.fn().mockResolvedValue(undefined);

    const runPromise = runSettleJob(
      { chain, provider, alertFn, alertWebhookUrl: "https://example.test/webhook" },
      { day: 20261006 },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await runPromise;

    expect(attempts).toBe(3);
    expect(alertFn).not.toHaveBeenCalled();
    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.settled).toBe(true);
    expect(entry.attempts).toBe(3);
  });

  it("reflects attempts and overrideAvailableAt in the status map", async () => {
    const record = marketRecord({ closeTs: 1_759_780_800 });
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        // succeed immediately
      },
      fetchMarket: alwaysOpenFetchMarket,
    };
    const provider = fakeProvider(async () => ({ priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 }));

    await runSettleJob({ chain, provider, alertWebhookUrl: undefined }, { day: 20261006 });

    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.attempts).toBe(1);
    expect(entry.settled).toBe(true);
    expect(entry.overrideAvailableAt).toBe(new Date((1_759_780_800 + 3600) * 1000).toISOString());
  });

  it("--once makes exactly one attempt and never alerts", async () => {
    const record = marketRecord();
    let attempts = 0;
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        attempts += 1;
        throw new Error("OracleStale");
      },
      fetchMarket: alwaysOpenFetchMarket,
    };
    const provider = fakeProvider(async () => ({ priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 }));
    const alertFn = vi.fn().mockResolvedValue(undefined);

    await runSettleJob({ chain, provider, alertFn, alertWebhookUrl: undefined }, { day: 20261006, once: true });

    expect(attempts).toBe(1);
    expect(alertFn).not.toHaveBeenCalled();
    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.nextRetryAt).toBeUndefined(); // fix #18: cleared even on single-pass termination
  });

  it("fix #4: two strikes on the same ticker settle against the same closing observation even if the source moves between attempts", async () => {
    const marketA = marketRecord({ strike: 670_000_000n });
    const marketB: MarketRecord = {
      publicKey: new PublicKey("11111111111111111111111111111115"),
      account: { ...marketA.account, strike: 690_000_000n },
    };

    let publishCalls = 0;
    const provider = fakeProvider(async () => {
      publishCalls += 1;
      // A different account every call would prove the bug if settle.ts called publish() more
      // than once per ticker per day.
      return {
        priceAccount: publishCalls === 1 ? PRICE_ACCOUNT : PRICE_ACCOUNT_2,
        publishTime: 1_759_780_900 + publishCalls,
      };
    });

    const settledWith: PublicKey[] = [];
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [marketA, marketB];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket(_market, priceAccount) {
        settledWith.push(priceAccount);
      },
      fetchMarket: alwaysOpenFetchMarket,
    };

    await runSettleJob({ chain, provider, alertWebhookUrl: undefined }, { day: 20261006 });

    expect(publishCalls).toBe(1); // published exactly once for the ticker, not once per strike
    expect(settledWith).toHaveLength(2);
    expect(settledWith[0].equals(PRICE_ACCOUNT)).toBe(true);
    expect(settledWith[1].equals(PRICE_ACCOUNT)).toBe(true); // same account for both strikes
  });

  it("fix #4: a pre-close observation is discarded and never used to settle", async () => {
    const record = marketRecord({ closeTs: 1_759_780_800 });
    let publishCalls = 0;
    const provider = fakeProvider(async () => {
      publishCalls += 1;
      // First publish is pre-close; second (after a retry) is post-close.
      return {
        priceAccount: PRICE_ACCOUNT,
        publishTime: publishCalls === 1 ? 1_759_780_700 : 1_759_780_900,
      };
    });

    let settleCalls = 0;
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        settleCalls += 1;
      },
      fetchMarket: alwaysOpenFetchMarket,
    };

    const runPromise = runSettleJob({ chain, provider, alertWebhookUrl: undefined }, { day: 20261006 });
    await vi.advanceTimersByTimeAsync(30_000);
    await runPromise;

    expect(publishCalls).toBe(2);
    expect(settleCalls).toBe(1); // settle_market was never called against the pre-close publish
    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.settled).toBe(true);
  });

  it("fix #17: a market already Settled on chain is reconciled as success instead of retried", async () => {
    const record = marketRecord();
    let state: "Open" | "Settled" = "Open";
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [record];
      },
      async fetchConfig() {
        return { overrideDelaySecs: 3600 };
      },
      async settleMarket() {
        throw new Error("OracleStale");
      },
      async fetchMarket() {
        return { state };
      },
    };
    const provider = fakeProvider(async () => ({ priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 }));
    const alertFn = vi.fn().mockResolvedValue(undefined);

    const runPromise = runSettleJob(
      { chain, provider, alertFn, alertWebhookUrl: "https://example.test/webhook" },
      { day: 20261006 },
    );

    // Another caller settles the market out from under us after the first attempt.
    await vi.advanceTimersByTimeAsync(0);
    state = "Settled";
    await vi.advanceTimersByTimeAsync(30_000);
    await runPromise;

    expect(alertFn).not.toHaveBeenCalled();
    const entry = settlementStatus.get(MARKET_PUBKEY.toBase58())!;
    expect(entry.settled).toBe(true);
  });

  it("fix #15: Config/market discovery failures retry within the window and alert once if never successful", async () => {
    let fetchConfigCalls = 0;
    const chain: SettleChain = {
      async fetchOpenMarkets() {
        return [];
      },
      async fetchConfig() {
        fetchConfigCalls += 1;
        throw new Error("RPC unavailable");
      },
      async settleMarket() {
        // never reached
      },
      fetchMarket: alwaysOpenFetchMarket,
    };
    const provider = fakeProvider(async () => ({ priceAccount: PRICE_ACCOUNT, publishTime: 1_759_780_900 }));
    const alertFn = vi.fn().mockResolvedValue(undefined);

    const runPromise = runSettleJob(
      { chain, provider, alertFn, alertWebhookUrl: "https://example.test/webhook" },
      { day: 20261006 },
    );

    for (let i = 0; i < 31; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await runPromise;

    expect(fetchConfigCalls).toBeGreaterThan(1); // retried, not aborted on the first failure
    expect(alertFn).toHaveBeenCalledTimes(1);
  });
});
