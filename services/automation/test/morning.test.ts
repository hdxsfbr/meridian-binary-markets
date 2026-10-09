import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { strikeLadder, type MicroUsd, type Ticker } from "@meridian/sdk";
import { runMorningJob, type MorningChain } from "../src/jobs/morning";
import type { PriceProvider } from "../src/providers/PriceProvider";
import * as logModule from "../src/log";

const SEVEN_TICKERS: Ticker[] = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"];

function fakeConfig(defaultBookCapacity = 128) {
  return {
    tickers: SEVEN_TICKERS.map((symbol) => ({ symbol, enabled: true })),
    defaultBookCapacity,
  };
}

function fakeMarketAddress(ticker: Ticker, tradingDay: number, strike: bigint): PublicKey {
  // Deterministic, distinct-per-input fake PDA: a real PublicKey derived from a seed string.
  const seed = `${ticker}-${tradingDay}-${strike}`;
  let hash = 0n;
  for (const ch of seed) hash = (hash * 131n + BigInt(ch.codePointAt(0) ?? 0)) % (2n ** 160n);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = Number((hash >> BigInt(i * 8)) & 0xffn);
  }
  return new PublicKey(bytes);
}

function buildChain(overrides: Partial<MorningChain> = {}): MorningChain & { calls: { createMarket: unknown[][] } } {
  const createMarketCalls: unknown[][] = [];
  const existing = new Set<string>();

  const chain: MorningChain & { calls: { createMarket: unknown[][] } } = {
    calls: { createMarket: createMarketCalls },
    async fetchMarket(pubkey: PublicKey) {
      return existing.has(pubkey.toBase58()) ? { book: PublicKey.default } : null;
    },
    marketAddress: fakeMarketAddress,
    async createMarket(ticker, strike, tradingDay, closeTs, capacity) {
      createMarketCalls.push([ticker, strike, tradingDay, closeTs, capacity]);
      const addr = fakeMarketAddress(ticker, tradingDay, strike);
      existing.add(addr.toBase58());
      return addr;
    },
    async createBookUntilDone() {
      // no-op
    },
    async fetchConfig() {
      return fakeConfig();
    },
    ...overrides,
  };
  return chain;
}

function fakeProvider(prevCloseByTicker: Record<string, bigint | Error>): PriceProvider {
  return {
    async previousClose(ticker: Ticker) {
      const v = prevCloseByTicker[ticker];
      if (v instanceof Error) throw v;
      return v as MicroUsd;
    },
    async publish() {
      throw new Error("not used in morning job tests");
    },
    async currentPrice() {
      throw new Error("not used in morning job tests");
    },
  };
}

describe("runMorningJob", () => {
  it("creates a market + book for every strike for every enabled ticker", async () => {
    const chain = buildChain();
    const provider = fakeProvider(Object.fromEntries(SEVEN_TICKERS.map((t) => [t, 680_000_000n])));

    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20261006 });

    // 7 tickers x 7 strikes each (round + 3 up + 3 down, all distinct for a round number).
    expect(chain.calls.createMarket.length).toBe(49); // 7 tickers x 7 strikes (680_000_000n microUSD ladder)
  });

  it("META at previous close 680 produces 7 createMarket calls, each followed by createBook", async () => {
    const createBookCalls: PublicKey[] = [];
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
      async createBookUntilDone(market: PublicKey) {
        createBookCalls.push(market);
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20261006 });

    const expectedStrikes = strikeLadder(680_000_000n as MicroUsd);
    expect(expectedStrikes.length).toBe(7);
    expect(chain.calls.createMarket.length).toBe(7);
    expect(createBookCalls.length).toBe(7);
  });

  it("one ticker's previousClose throwing skips only that ticker; the other six proceed", async () => {
    const chain = buildChain();
    const prevClose: Record<string, bigint | Error> = Object.fromEntries(
      SEVEN_TICKERS.map((t) => [t, 680_000_000n]),
    );
    prevClose.META = new Error("source outage");
    const provider = fakeProvider(prevClose);

    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20261006 });

    // META contributed zero createMarket calls; the other six contributed 7 each.
    const metaCalls = chain.calls.createMarket.filter((args) => args[0] === "META");
    expect(metaCalls.length).toBe(0);
    // 6 remaining tickers x 7 strikes each (680_000_000n microUSD ladder).
    expect(chain.calls.createMarket.length).toBe(42);
  });

  it("skips a market whose PDA already exists (idempotent re-run)", async () => {
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20261006 });
    expect(chain.calls.createMarket.length).toBe(7);

    // Second run, same day: every market PDA now exists, so nothing new is created.
    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20261006 });
    expect(chain.calls.createMarket.length).toBe(7);
  });

  it("uses DEMO_SCALE capacity (16) when demoScale is set, else the config default", async () => {
    const seenCapacities: number[] = [];
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
      async createMarket(ticker, strike, tradingDay, closeTs, capacity) {
        seenCapacities.push(capacity);
        return fakeMarketAddress(ticker, tradingDay, strike);
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    await runMorningJob({ chain, provider, demoScale: true, retry: (fn) => fn() }, { day: 20261006 });
    expect(seenCapacities.every((c) => c === 16)).toBe(true);
  });

  it("applies the --close-in demo override instead of 16:00 ET", async () => {
    const seenCloseTs: number[] = [];
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
      async createMarket(ticker, strike, tradingDay, closeTs) {
        seenCloseTs.push(closeTs);
        return fakeMarketAddress(ticker, tradingDay, strike);
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    // `now` (Oct 6, 2026) deliberately differs from the synthetic `day` (Oct 13, 2026):
    // fix #11 refuses --close-in on the real current trading day.
    const now = () => Date.UTC(2026, 9, 6, 12, 0, 0);
    await runMorningJob(
      { chain, provider, demoScale: false, retry: (fn) => fn(), now },
      { day: 20261013, closeInSeconds: 300 },
    );

    const expected = Math.floor(now() / 1000) + 300;
    expect(seenCloseTs.every((ts) => ts === expected)).toBe(true);
  });

  it("retries a failing createMarket transaction via the injected retry wrapper", async () => {
    let attempts = 0;
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
      async createMarket(ticker, strike, tradingDay) {
        attempts += 1;
        if (attempts < 3) throw new Error("transient RPC error");
        return fakeMarketAddress(ticker, tradingDay, strike);
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    const retry = vi.fn(async <T>(fn: () => Promise<T>) => {
      let lastErr: unknown;
      for (let i = 0; i < 3; i += 1) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    });

    await runMorningJob({ chain, provider, demoScale: false, retry }, { day: 20261006 });
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("fix #9: calls createBookUntilDone for an existing market instead of skipping it outright", async () => {
    const bookCalls: string[] = [];
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
      async createBookUntilDone(market: PublicKey) {
        bookCalls.push(market.toBase58());
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20261006 });
    expect(bookCalls.length).toBe(7); // first run: market+book created for every strike

    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20261006 });
    // second run: markets already exist, so createMarket isn't called again, but
    // createBookUntilDone still is, for every strike.
    expect(chain.calls.createMarket.length).toBe(7);
    expect(bookCalls.length).toBe(14);
  });

  it("fix #9: re-fetches the PDA after an ambiguous createMarket failure instead of assuming it failed", async () => {
    const bookCalls: string[] = [];
    const existing = new Set<string>();

    const chain: MorningChain = {
      async fetchMarket(pubkey: PublicKey) {
        return existing.has(pubkey.toBase58()) ? { book: PublicKey.default } : null;
      },
      marketAddress: fakeMarketAddress,
      async createMarket(ticker, strike, tradingDay) {
        // Simulate the transaction actually landing on chain, then the confirmation call
        // throwing anyway (an "ambiguous" failure): the market exists on chain by the time
        // morning.ts re-checks, even though this call itself threw.
        existing.add(fakeMarketAddress(ticker, tradingDay, strike).toBase58());
        throw new Error("ambiguous: confirmation timed out");
      },
      async createBookUntilDone(market: PublicKey) {
        bookCalls.push(market.toBase58());
      },
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
    };
    const provider = fakeProvider({ META: 680_000_000n });

    // Retry wrapper that gives up immediately so the ambiguous-failure path in morning.ts
    // (not the retry wrapper) is what recovers.
    const noRetry = async <T>(fn: () => Promise<T>) => fn();

    await runMorningJob({ chain, provider, demoScale: false, retry: noRetry }, { day: 20261006 });

    // Every strike's createMarket "failed" ambiguously but was actually on chain, so every
    // strike still gets its book created rather than the whole ticker being abandoned.
    expect(bookCalls.length).toBe(7);
  });

  it("fix #12: a single strike's createMarket 'already in use' failure doesn't abort the ticker", async () => {
    const failingStrikeIndex = 2; // an arbitrary strike partway through the ladder
    let strikeCallCount = 0;
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
      async createMarket(ticker, strike, tradingDay, closeTs, capacity) {
        const idx = strikeCallCount;
        strikeCallCount += 1;
        chain.calls.createMarket.push([ticker, strike, tradingDay, closeTs, capacity]);
        if (idx === failingStrikeIndex) {
          throw new Error("Allocate: account X already in use");
        }
        const addr = fakeMarketAddress(ticker, tradingDay, strike);
        return addr;
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    const expectedStrikes = strikeLadder(680_000_000n as MicroUsd);
    expect(expectedStrikes.length).toBe(7);

    const logSpy = vi.spyOn(logModule, "log");
    const logErrorSpy = vi.spyOn(logModule, "logError");

    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20261006 });

    // Every strike was attempted (the failing one did not abort the loop), so createMarket
    // was called once per strike in the ladder.
    expect(chain.calls.createMarket.length).toBe(expectedStrikes.length);

    // The failed strike was logged with the clearer "already in use" message, not the raw error.
    const strikeFailureLogs = logErrorSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.step === "strike" && event.ok === false);
    expect(strikeFailureLogs.length).toBe(1);
    expect(strikeFailureLogs[0].error).toContain("strike key was used by an earlier closed market");

    // The ticker-level summary reflects 6 created and 1 skipped (the failed strike), 0 existing.
    const summaryLogs = logSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.step === "ticker_summary");
    expect(summaryLogs.length).toBe(1);
    expect(summaryLogs[0].error).toBe("created=6 existing=0 skipped=1");

    logSpy.mockRestore();
    logErrorSpy.mockRestore();
  });

  it("fix #10: exits without creating markets on a non-trading day, unless --force", async () => {
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    // 2026-01-01 is New Year's Day: a weekday holiday, not a trading day.
    await runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { day: 20260101 });
    expect(chain.calls.createMarket.length).toBe(0);

    await runMorningJob(
      { chain, provider, demoScale: false, retry: (fn) => fn() },
      { day: 20260101, force: true },
    );
    expect(chain.calls.createMarket.length).toBe(7);
  });

  it("fix #11: --close-in requires --day and rejects non-positive-integer values", async () => {
    const chain = buildChain({
      async fetchConfig() {
        return { tickers: [{ symbol: "META" as Ticker, enabled: true }], defaultBookCapacity: 128 };
      },
    });
    const provider = fakeProvider({ META: 680_000_000n });

    await expect(
      runMorningJob({ chain, provider, demoScale: false, retry: (fn) => fn() }, { closeInSeconds: 300 }),
    ).rejects.toThrow(/only allowed together with --day/);

    await expect(
      runMorningJob(
        { chain, provider, demoScale: false, retry: (fn) => fn() },
        { day: 20261013, closeInSeconds: 0 },
      ),
    ).rejects.toThrow(/positive integer/);

    await expect(
      runMorningJob(
        { chain, provider, demoScale: false, retry: (fn) => fn() },
        { day: 20261013, closeInSeconds: 1.5 },
      ),
    ).rejects.toThrow(/positive integer/);

    const now = () => Date.UTC(2026, 9, 6, 12, 0, 0); // "today" = 2026-10-06
    await expect(
      runMorningJob(
        { chain, provider, demoScale: false, retry: (fn) => fn(), now },
        { day: 20261006, closeInSeconds: 300 },
      ),
    ).rejects.toThrow(/real current trading day/);
  });
});
