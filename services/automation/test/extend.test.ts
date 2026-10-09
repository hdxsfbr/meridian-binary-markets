import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { MicroUsd, Ticker } from "@meridian/sdk";
import {
  createExtendState,
  createGuardedExtendTick,
  isWithinExtendWindow,
  loadExtendState,
  saveExtendState,
  MAX_EXTENSIONS_PER_DAY,
  runExtendTick,
  type ExtendChain,
  type ExtendMarketSummary,
} from "../src/jobs/extend";
import type { PriceProvider } from "../src/providers/PriceProvider";
import * as logModule from "../src/log";

const DAY = 20261006;
const CLOSE_TS = 1_759_780_800;

function fakeMarketAddress(ticker: Ticker, tradingDay: number, strike: bigint): PublicKey {
  const seed = `${ticker}-${tradingDay}-${strike}`;
  let hash = 0n;
  for (const ch of seed) hash = (hash * 131n + BigInt(ch.codePointAt(0) ?? 0)) % (2n ** 160n);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = Number((hash >> BigInt(i * 8)) & 0xffn);
  }
  return new PublicKey(bytes);
}

interface SeedMarket {
  ticker: Ticker;
  strike: bigint;
  closeTs: number;
}

function buildChain(
  seed: SeedMarket[],
  tickers: Array<{ symbol: Ticker; enabled: boolean }>,
  overrides: Partial<ExtendChain> = {},
): ExtendChain & { calls: { createMarket: unknown[][] }; markets: SeedMarket[] } {
  const markets: SeedMarket[] = [...seed];
  const createMarketCalls: unknown[][] = [];

  const chain: ExtendChain & { calls: { createMarket: unknown[][] }; markets: SeedMarket[] } = {
    calls: { createMarket: createMarketCalls },
    markets,
    marketAddress: (ticker, tradingDay, strike) => fakeMarketAddress(ticker, tradingDay, strike),
    async fetchMarket(pubkey: PublicKey) {
      const found = markets.find((m) => fakeMarketAddress(m.ticker, DAY, m.strike).equals(pubkey));
      return found ? { book: PublicKey.default } : null;
    },
    async createMarket(ticker, strike, tradingDay, closeTs, capacity) {
      createMarketCalls.push([ticker, strike, tradingDay, closeTs, capacity]);
      markets.push({ ticker, strike, closeTs });
      return fakeMarketAddress(ticker, tradingDay, strike);
    },
    async createBookUntilDone() {
      // no-op
    },
    async fetchConfig() {
      return { tickers, defaultBookCapacity: 128 };
    },
    async fetchOpenMarkets(tradingDay: number) {
      return markets.map((m) => ({
        publicKey: fakeMarketAddress(m.ticker, tradingDay, m.strike),
        account: { ticker: m.ticker, strike: m.strike, closeTs: m.closeTs } as ExtendMarketSummary,
      }));
    },
    ...overrides,
  };
  return chain;
}

function fakeProvider(priceFn: (ticker: Ticker) => bigint | Error): PriceProvider {
  return {
    async currentPrice(ticker: Ticker) {
      const v = priceFn(ticker);
      if (v instanceof Error) throw v;
      return v as MicroUsd;
    },
    async previousClose() {
      throw new Error("not used in extend job tests");
    },
    async publish() {
      throw new Error("not used in extend job tests");
    },
  };
}

const WITHIN_WINDOW_NOW = () => Date.UTC(2026, 9, 6, 15, 0, 0); // 11:00 ET on 2026-10-06 (DST, UTC-4)
const OUTSIDE_WINDOW_NOW = () => Date.UTC(2026, 9, 6, 12, 0, 0); // 08:00 ET -- before the window opens

describe("isWithinExtendWindow", () => {
  it("is true only inside 09:35-15:45 ET on a trading day", () => {
    expect(isWithinExtendWindow(Math.floor(WITHIN_WINDOW_NOW() / 1000))).toBe(true);
    expect(isWithinExtendWindow(Math.floor(OUTSIDE_WINDOW_NOW() / 1000))).toBe(false);
  });
});

describe("runExtendTick", () => {
  it("does nothing when the live price is mid-ladder", async () => {
    const chain = buildChain(
      [
        { ticker: "META" as Ticker, strike: 670_000_000n, closeTs: CLOSE_TS },
        { ticker: "META" as Ticker, strike: 680_000_000n, closeTs: CLOSE_TS },
        { ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS },
      ],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 680_000_000n); // the middle strike -- outside the $5 buffer of either end
    const state = createExtendState();

    await runExtendTick(
      { chain, provider, demoScale: false, state, retry: (fn) => fn() },
      { day: DAY, force: true },
    );
    await runExtendTick(
      { chain, provider, demoScale: false, state, retry: (fn) => fn() },
      { day: DAY, force: true },
    );

    expect(chain.calls.createMarket.length).toBe(0);
  });

  it("requires two consecutive ticks before creating: first tick records, second creates", async () => {
    // highest strike $690; half-step buffer is $5, so $686 is within buffer of the top.
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 686_000_000n);
    const state = createExtendState();

    await runExtendTick(
      { chain, provider, demoScale: false, state, retry: (fn) => fn() },
      { day: DAY, force: true },
    );
    expect(chain.calls.createMarket.length).toBe(0);

    await runExtendTick(
      { chain, provider, demoScale: false, state, retry: (fn) => fn() },
      { day: DAY, force: true },
    );
    expect(chain.calls.createMarket.length).toBe(1);
    expect(chain.calls.createMarket[0][0]).toBe("META");
    expect(chain.calls.createMarket[0][1]).toBe(700_000_000n); // highest ($690) + one $10 step
  });

  it("extends above the ladder on the $10 grid", async () => {
    const chain = buildChain(
      [
        { ticker: "META" as Ticker, strike: 670_000_000n, closeTs: CLOSE_TS },
        { ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS },
      ],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 687_000_000n); // within $5 of the $690 top
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce();
    await tickOnce();

    expect(chain.calls.createMarket.length).toBe(1);
    expect(chain.calls.createMarket[0][1]).toBe(700_000_000n);
  });

  it("extends below the ladder on the $10 grid", async () => {
    const chain = buildChain(
      [
        { ticker: "META" as Ticker, strike: 670_000_000n, closeTs: CLOSE_TS },
        { ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS },
      ],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 673_000_000n); // within $5 of the $670 bottom
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce();
    await tickOnce();

    expect(chain.calls.createMarket.length).toBe(1);
    expect(chain.calls.createMarket[0][1]).toBe(660_000_000n);
  });

  it("caps at 2 added strikes per ticker per trading day", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 680_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    // Always $4 below whatever the current top strike is -- condition re-confirms itself
    // after every extension, so without the cap this would keep extending forever.
    const provider = fakeProvider(() => {
      const highest = chain.markets.reduce((a, m) => (m.strike > a ? m.strike : a), 0n);
      return highest - 4_000_000n;
    });
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    for (let i = 0; i < 8; i += 1) {
      await tickOnce();
    }

    expect(chain.calls.createMarket.length).toBe(MAX_EXTENSIONS_PER_DAY);
  });

  it("skips and counts an 'already in use' create_market failure against the cap", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
      {
        async createMarket(ticker, strike, tradingDay, closeTs, capacity) {
          chain.calls.createMarket.push([ticker, strike, tradingDay, closeTs, capacity]);
          throw new Error("Allocate: account X already in use");
        },
      },
    );
    const provider = fakeProvider(() => 686_000_000n);
    const state = createExtendState();
    const logErrorSpy = vi.spyOn(logModule, "logError");
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    // Cycle 1: two ticks -> one failed create_market attempt (cap now at 1).
    await tickOnce();
    await tickOnce();
    // Cycle 2: two more ticks -> a second failed attempt (cap now at 2).
    await tickOnce();
    await tickOnce();
    // Cycle 3: cap already reached -- no further attempt even though the condition still holds.
    await tickOnce();
    await tickOnce();

    expect(chain.calls.createMarket.length).toBe(MAX_EXTENSIONS_PER_DAY);
    const skipLogs = logErrorSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.step === "skip" && event.ok === false);
    expect(skipLogs.length).toBe(MAX_EXTENSIONS_PER_DAY);
    expect(skipLogs[0].error).toContain("strike key was used by an earlier closed market");

    logErrorSpy.mockRestore();
  });

  it("copies closeTs from the existing market instead of recomputing it", async () => {
    const customCloseTs = 1_759_999_999;
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: customCloseTs }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 686_000_000n);
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce();
    await tickOnce();

    expect(chain.calls.createMarket.length).toBe(1);
    expect(chain.calls.createMarket[0][3]).toBe(customCloseTs);
  });

  it("does nothing outside the 09:35-15:45 ET window without --force", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 686_000_000n);
    const state = createExtendState();

    await runExtendTick(
      { chain, provider, demoScale: false, state, retry: (fn) => fn(), now: OUTSIDE_WINDOW_NOW },
      {},
    );
    await runExtendTick(
      { chain, provider, demoScale: false, state, retry: (fn) => fn(), now: OUTSIDE_WINDOW_NOW },
      {},
    );

    expect(chain.calls.createMarket.length).toBe(0);
  });

  it("does nothing for a ticker with no markets today (morning owns creation)", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [
        { symbol: "META" as Ticker, enabled: true },
        { symbol: "TSLA" as Ticker, enabled: true }, // no markets seeded for TSLA today
      ],
    );
    const provider = fakeProvider((ticker) => (ticker === "META" ? 686_000_000n : 300_000_000n));
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce();
    await tickOnce();

    expect(chain.calls.createMarket.length).toBe(1);
    expect(chain.calls.createMarket[0][0]).toBe("META");
  });

  it("an error in one ticker does not affect the others", async () => {
    const chain = buildChain(
      [
        { ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS },
        { ticker: "TSLA" as Ticker, strike: 400_000_000n, closeTs: CLOSE_TS },
      ],
      [
        { symbol: "META" as Ticker, enabled: true },
        { symbol: "TSLA" as Ticker, enabled: true },
      ],
    );
    const provider = fakeProvider((ticker) => {
      if (ticker === "META") throw new Error("source outage");
      return 396_000_000n; // within $5 of TSLA's $400 top
    });
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce();
    await tickOnce();

    const metaCalls = chain.calls.createMarket.filter((args) => args[0] === "META");
    const tslaCalls = chain.calls.createMarket.filter((args) => args[0] === "TSLA");
    expect(metaCalls.length).toBe(0);
    expect(tslaCalls.length).toBe(1);
  });
});

describe("review fix #1: the day's allowance is reserved before createMarket, and kept on a book failure", () => {
  it("consumes the allowance for a market whose book never finishes", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
      {
        async createBookUntilDone() {
          throw new Error("book creation always fails in this test");
        },
      },
    );
    const provider = fakeProvider(() => 686_000_000n);
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce();
    await tickOnce();

    // The market was created (rent spent)...
    expect(chain.calls.createMarket.length).toBe(1);
    // ...and the per-day allowance was reserved for it even though its book never finished.
    expect(state.dailyCreated.get("META" as Ticker)).toEqual({ day: DAY, count: 1 });
    expect(state.bookPending.size).toBe(1);
  });

  it("releases the reservation when createMarket genuinely fails (not 'already in use') and a re-fetch confirms no market exists", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
      {
        async createMarket(ticker, strike, tradingDay, closeTs, capacity) {
          chain.calls.createMarket.push([ticker, strike, tradingDay, closeTs, capacity]);
          throw new Error("RPC timed out");
        },
      },
    );
    const provider = fakeProvider(() => 686_000_000n);
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce();
    await tickOnce();

    expect(chain.calls.createMarket.length).toBe(1);
    // Genuinely failed (not "already in use") and the re-fetch found nothing -- the
    // reservation must be released, not left consumed on a no-op attempt.
    expect(state.dailyCreated.get("META" as Ticker)?.count ?? 0).toBe(0);
  });
});

describe("review fix #2: a pending book is retried every tick and excluded from edge detection", () => {
  it("retries an unfinished book every tick, independent of edge detection and the cap, until it completes", async () => {
    let bookAttempts = 0;
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
      {
        async createBookUntilDone() {
          bookAttempts += 1;
          if (bookAttempts < 3) {
            throw new Error(`book not ready yet (attempt ${bookAttempts})`);
          }
        },
      },
    );
    const provider = fakeProvider(() => 686_000_000n); // within $5 of whichever strike is the complete ladder's top
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce(); // hit 1 toward $700
    await tickOnce(); // hit 2 -> creates $700; its book fails on attempt 1
    expect(chain.calls.createMarket.length).toBe(1);
    expect(state.bookPending.size).toBe(1);

    await tickOnce(); // pending retry (attempt 2, still fails); $700 stays excluded from edge
    // detection, so the ladder's complete top stays at $690 -- the next target is still
    // $700 (the pending strike itself), never $710 (the strike beyond it).
    expect(chain.calls.createMarket.length).toBe(1);
    expect(state.bookPending.size).toBe(1);
    expect(state.consecutive.get("META" as Ticker)?.strike).toBe(700_000_000n);

    await tickOnce(); // pending retry succeeds (attempt 3) -> book completes
    expect(state.bookPending.size).toBe(0);
    expect(bookAttempts).toBe(3);
    // Still only the one market ever created -- the pending-book retries never call
    // createMarket, only createBookUntilDone.
    expect(chain.calls.createMarket.length).toBe(1);
  });
});

describe("review fix #3: the two-consecutive-tick streak is keyed by trading day and tick cadence", () => {
  it("resets the streak when the trading day changes", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 686_000_000n);
    const state = createExtendState();

    await runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });
    expect(state.consecutive.get("META" as Ticker)?.count).toBe(1);

    const nextDay = 20261007;
    await runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: nextDay, force: true });

    // A new trading day: yesterday's single hit must not combine with today's first hit.
    expect(chain.calls.createMarket.length).toBe(0);
    expect(state.consecutive.get("META" as Ticker)?.count).toBe(1);
    expect(state.consecutive.get("META" as Ticker)?.day).toBe(nextDay);
  });

  it("requires the two hits within 1.5x the tick interval, not merely two hits ever", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 686_000_000n);
    const state = createExtendState();
    let nowMs = 1_700_000_000_000;
    const tick = () =>
      runExtendTick(
        { chain, provider, demoScale: false, state, retry: (fn) => fn(), now: () => nowMs },
        { day: DAY, force: true },
      );

    await tick(); // hit 1 at t0
    nowMs += 20 * 60_000; // 20 minutes later -- far more than 1.5x the 5-minute interval
    await tick(); // a second hit, but too far after the first to count as consecutive

    expect(chain.calls.createMarket.length).toBe(0);
    expect(state.consecutive.get("META" as Ticker)?.count).toBe(1); // restarted as a fresh first hit
  });

  it("clears the streak on a failed price observation", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    let fail = false;
    const provider = fakeProvider(() => (fail ? new Error("source outage") : 686_000_000n));
    const state = createExtendState();
    const tickOnce = () =>
      runExtendTick({ chain, provider, demoScale: false, state, retry: (fn) => fn() }, { day: DAY, force: true });

    await tickOnce(); // hit 1
    expect(state.consecutive.get("META" as Ticker)?.count).toBe(1);

    fail = true;
    await tickOnce(); // failed observation -- clears the streak outright
    expect(state.consecutive.has("META" as Ticker)).toBe(false);

    fail = false;
    await tickOnce(); // fresh hit 1
    await tickOnce(); // hit 2 -- only now does this create
    expect(chain.calls.createMarket.length).toBe(1);
  });
});

describe("review fix #4: the holiday calendar fails closed for an unsupported year", () => {
  it("treats a trading day in a year with no static holiday table as not a trading day, logging once per day", () => {
    const state = createExtendState();
    const logErrorSpy = vi.spyOn(logModule, "logError");

    // 2027-01-04 is a Monday; the static NYSE holiday table only covers 2026.
    const nowSeconds = Math.floor(Date.UTC(2027, 0, 4, 15, 0, 0) / 1000); // ~10:00 ET

    expect(isWithinExtendWindow(nowSeconds, state)).toBe(false);
    expect(isWithinExtendWindow(nowSeconds, state)).toBe(false); // second call: still false

    const calendarLogs = logErrorSpy.mock.calls.map(([event]) => event).filter((event) => event.step === "calendar");
    expect(calendarLogs.length).toBe(1); // logged once, not once per call

    logErrorSpy.mockRestore();
  });
});

describe("review fix #5: createGuardedExtendTick's in-flight guard", () => {
  it("skips a tick while the previous one is still running, and allows the next one once it settles", async () => {
    let fetchConfigCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const originalFetchConfig = chain.fetchConfig.bind(chain);
    chain.fetchConfig = async () => {
      fetchConfigCalls += 1;
      if (fetchConfigCalls === 1) await gate;
      return originalFetchConfig();
    };
    const provider = fakeProvider(() => 680_000_000n); // mid-ladder: never triggers creation
    const state = createExtendState();
    const logSpy = vi.spyOn(logModule, "log");

    const tick = createGuardedExtendTick(() => ({ chain, provider, demoScale: false, state, retry: (fn) => fn() }), {
      tickOpts: { day: DAY, force: true },
    });

    tick(); // starts tick 1; blocks inside runExtendTick on the gated fetchConfig
    tick(); // tick 2: the in-flight guard must skip this synchronously

    expect(fetchConfigCalls).toBe(1);
    const skipLogs = logSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.step === "cron" && typeof event.error === "string" && event.error.includes("skipped"));
    expect(skipLogs.length).toBe(1);

    release!();
    // Flush the microtask queue a couple of times so tick 1's `.finally()` runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    tick(); // tick 3: now allowed, since tick 1 has settled
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchConfigCalls).toBe(2);

    logSpy.mockRestore();
  });

  it("calls onSettled after every tick, successful or not", async () => {
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 680_000_000n);
    const state = createExtendState();
    let settledCount = 0;

    const tick = createGuardedExtendTick(
      () => ({ chain, provider, demoScale: false, state, retry: (fn) => fn() }),
      { tickOpts: { day: DAY, force: true }, onSettled: () => (settledCount += 1) },
    );

    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settledCount).toBe(1);
  });
});

describe("review fix #9: extend state is persisted so it survives across invocations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "extend-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips bigints, Maps, and the day/holiday-log fields through JSON", async () => {
    const path = join(dir, "extend-state.json");
    const state = createExtendState();
    state.day = DAY;
    state.loggedMissingHolidayDay = 20270104;
    state.consecutive.set("META" as Ticker, { direction: "above", strike: 700_000_000n, count: 1, day: DAY, lastTickAt: 123 });
    state.dailyCreated.set("META" as Ticker, { day: DAY, count: 1 });
    state.bookPending.set("SomeMarketAddr11111111111111111111111111", {
      ticker: "META" as Ticker,
      strike: 700_000_000n,
      tradingDay: DAY,
      closeTs: CLOSE_TS,
      capacity: 16,
    });

    await saveExtendState(path, state);
    const loaded = await loadExtendState(path);

    expect(loaded.day).toBe(DAY);
    expect(loaded.loggedMissingHolidayDay).toBe(20270104);
    expect(loaded.consecutive.get("META" as Ticker)).toEqual({
      direction: "above",
      strike: 700_000_000n,
      count: 1,
      day: DAY,
      lastTickAt: 123,
    });
    expect(loaded.dailyCreated.get("META" as Ticker)).toEqual({ day: DAY, count: 1 });
    expect(loaded.bookPending.get("SomeMarketAddr11111111111111111111111111")).toEqual({
      ticker: "META",
      strike: 700_000_000n,
      tradingDay: DAY,
      closeTs: CLOSE_TS,
      capacity: 16,
    });
  });

  it("returns a fresh state when the file doesn't exist", async () => {
    const loaded = await loadExtendState(join(dir, "does-not-exist.json"));
    expect(loaded.day).toBeNull();
    expect(loaded.consecutive.size).toBe(0);
    expect(loaded.dailyCreated.size).toBe(0);
    expect(loaded.bookPending.size).toBe(0);
  });

  it("lets two manual `job extend --once` invocations five minutes apart accumulate the same streak", async () => {
    const path = join(dir, "extend-state.json");
    const chain = buildChain(
      [{ ticker: "META" as Ticker, strike: 690_000_000n, closeTs: CLOSE_TS }],
      [{ symbol: "META" as Ticker, enabled: true }],
    );
    const provider = fakeProvider(() => 686_000_000n);

    // Invocation 1: a fresh CLI process with nothing on disk yet, ticks once, saves.
    const state1 = await loadExtendState(path);
    await runExtendTick({ chain, provider, demoScale: false, state: state1, retry: (fn) => fn() }, { day: DAY, force: true });
    await saveExtendState(path, state1);
    expect(chain.calls.createMarket.length).toBe(0);

    // Invocation 2: a brand-new process/state object, five minutes later -- loads the saved
    // streak from disk instead of starting over from a fresh `createExtendState()`.
    const state2 = await loadExtendState(path);
    expect(state2.consecutive.get("META" as Ticker)?.count).toBe(1);
    await runExtendTick(
      { chain, provider, demoScale: false, state: state2, retry: (fn) => fn(), now: () => Date.now() + 5 * 60_000 },
      { day: DAY, force: true },
    );

    expect(chain.calls.createMarket.length).toBe(1);
  });
});
