import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, usdcEscrowPda, vaultPda, type BookHeader, type Ticker } from "@meridian/sdk";
import { runReclaimJob, RECLAIM_MIN_AGE_SECONDS, type ReclaimChain } from "../src/jobs/reclaim";
import type { MarketAccount, MarketRecord } from "../src/chain";

const BOOK_A = new PublicKey("11111111111111111111111111111112");
const BOOK_B = new PublicKey("11111111111111111111111111111113");

function marketRecord(overrides: Partial<MarketAccount> = {}, pubkeySeed = "1"): MarketRecord {
  const pubkeyBytes = new Uint8Array(32);
  pubkeyBytes[0] = Number(pubkeySeed);
  return {
    publicKey: new PublicKey(pubkeyBytes),
    account: {
      ticker: "AAPL" as Ticker,
      strike: 200_000_000n,
      tradingDay: 20261001,
      closeTs: 1_759_000_000,
      state: "Settled",
      outcome: "Yes",
      settlementPrice: 210_000_000n,
      settledAt: 1_759_000_100,
      settledByOverride: false,
      yesMint: PublicKey.default,
      noMint: PublicKey.default,
      vault: PublicKey.default,
      book: PublicKey.default,
      bookCapacity: 16,
      pairsOutstanding: 0n,
      ...overrides,
    },
  };
}

function emptyHeader(): BookHeader {
  return {
    market: PublicKey.default,
    usdcEscrow: PublicKey.default,
    yesEscrow: PublicKey.default,
    nextOrderId: 1n,
    nextSeq: 1n,
    capacity: 16,
    bidCount: 0,
    askCount: 0,
  };
}

interface FakeChainOpts {
  markets: MarketRecord[];
  headers?: Map<string, BookHeader | null>;
  balances?: Map<string, bigint>;
  failCloseBookFor?: Set<string>;
}

function buildChain(opts: FakeChainOpts) {
  const calls = { closeBook: [] as string[], closeMarket: [] as string[] };
  const headers = opts.headers ?? new Map<string, BookHeader | null>();
  const balances = opts.balances ?? new Map<string, bigint>();

  const chain: ReclaimChain = {
    async fetchSettledMarkets(olderThanTs?: number) {
      if (olderThanTs === undefined) return opts.markets;
      return opts.markets.filter((m) => m.account.settledAt <= olderThanTs);
    },
    async fetchBookHeader(book: PublicKey) {
      return headers.has(book.toBase58()) ? headers.get(book.toBase58())! : null;
    },
    async getTokenAccountBalance(pubkey: PublicKey) {
      return balances.get(pubkey.toBase58()) ?? 0n;
    },
    async closeBook(market: PublicKey) {
      const key = market.toBase58();
      if (opts.failCloseBookFor?.has(key)) throw new Error("NotEmpty");
      calls.closeBook.push(key);
    },
    async closeMarket(market: PublicKey) {
      calls.closeMarket.push(market.toBase58());
    },
  };

  return { chain, calls };
}

describe("runReclaimJob", () => {
  it("closes a settled market whose book and vault are both empty", async () => {
    const record = marketRecord({ book: BOOK_A }, "1");
    const headers = new Map([[BOOK_A.toBase58(), emptyHeader()]]);
    const { chain, calls } = buildChain({ markets: [record], headers, balances: new Map() });

    await runReclaimJob({ chain }, { allSettled: true });

    expect(calls.closeBook).toEqual([record.publicKey.toBase58()]);
    expect(calls.closeMarket).toEqual([record.publicKey.toBase58()]);
  });

  it("skips close_book when the book still has resting orders, and never attempts close_market", async () => {
    const record = marketRecord({ book: BOOK_A }, "2");
    const header: BookHeader = { ...emptyHeader(), bidCount: 1 };
    const headers = new Map([[BOOK_A.toBase58(), header]]);
    const { chain, calls } = buildChain({ markets: [record], headers });

    await runReclaimJob({ chain }, { allSettled: true });

    expect(calls.closeBook).toEqual([]);
    expect(calls.closeMarket).toEqual([]);
  });

  it("skips close_book when an escrow still holds a balance", async () => {
    const record = marketRecord({ book: BOOK_A }, "3");
    const headers = new Map([[BOOK_A.toBase58(), emptyHeader()]]);
    const [usdcEscrow] = usdcEscrowPda(PROGRAM_ID, record.publicKey);
    const balances = new Map([[usdcEscrow.toBase58(), 1n]]);
    const { chain, calls } = buildChain({ markets: [record], headers, balances });

    await runReclaimJob({ chain }, { allSettled: true });

    expect(calls.closeBook).toEqual([]);
    expect(calls.closeMarket).toEqual([]);
  });

  it("closes only the market when the book is already closed and the vault is empty", async () => {
    const record = marketRecord({ book: PublicKey.default }, "4");
    const { chain, calls } = buildChain({ markets: [record] });

    await runReclaimJob({ chain }, { allSettled: true });

    expect(calls.closeBook).toEqual([]);
    expect(calls.closeMarket).toEqual([record.publicKey.toBase58()]);
  });

  it("skips close_market when the vault still holds a balance", async () => {
    const record = marketRecord({ book: PublicKey.default }, "5");
    const [vault] = vaultPda(PROGRAM_ID, record.publicKey);
    const balances = new Map([[vault.toBase58(), 1_000_000n]]);
    const { chain, calls } = buildChain({ markets: [record], balances });

    await runReclaimJob({ chain }, { allSettled: true });

    expect(calls.closeMarket).toEqual([]);
  });

  it("dry-run calls neither closeBook nor closeMarket", async () => {
    const record = marketRecord({ book: BOOK_A }, "6");
    const headers = new Map([[BOOK_A.toBase58(), emptyHeader()]]);
    const { chain, calls } = buildChain({ markets: [record], headers });

    await runReclaimJob({ chain }, { allSettled: true, dryRun: true });

    expect(calls.closeBook).toEqual([]);
    expect(calls.closeMarket).toEqual([]);
  });

  it("one market's failure does not stop the loop from processing the rest", async () => {
    const failing = marketRecord({ book: BOOK_A }, "7");
    const succeeding = marketRecord({ book: BOOK_B }, "8");
    const headers = new Map([
      [BOOK_A.toBase58(), emptyHeader()],
      [BOOK_B.toBase58(), emptyHeader()],
    ]);
    const { chain, calls } = buildChain({
      markets: [failing, succeeding],
      headers,
      failCloseBookFor: new Set([failing.publicKey.toBase58()]),
    });

    await runReclaimJob({ chain }, { allSettled: true });

    expect(calls.closeBook).toEqual([succeeding.publicKey.toBase58()]);
    expect(calls.closeMarket).toEqual([succeeding.publicKey.toBase58()]);
  });

  it("without --all-settled, only passes the 24h-ago cutoff to fetchSettledMarkets", async () => {
    const record = marketRecord({ book: PublicKey.default }, "9");
    let seenCutoff: number | undefined;
    const chain: ReclaimChain = {
      async fetchSettledMarkets(olderThanTs) {
        seenCutoff = olderThanTs;
        return [];
      },
      async fetchBookHeader() {
        return null;
      },
      async getTokenAccountBalance() {
        return 0n;
      },
      async closeBook() {},
      async closeMarket() {},
    };

    const fixedNowMs = 1_759_100_000_000;
    await runReclaimJob({ chain, now: () => fixedNowMs }, {});

    expect(seenCutoff).toBe(Math.floor(fixedNowMs / 1000) - RECLAIM_MIN_AGE_SECONDS);
    expect(record.account.book.equals(PublicKey.default)).toBe(true);
  });

  it("fix #23: an RPC error on a balance read skips that market and closes nothing, in a normal run", async () => {
    const record = marketRecord({ book: BOOK_A }, "12");
    const headers = new Map([[BOOK_A.toBase58(), emptyHeader()]]);
    const calls = { closeBook: 0, closeMarket: 0 };
    const chain: ReclaimChain = {
      async fetchSettledMarkets() {
        return [record];
      },
      async fetchBookHeader(book: PublicKey) {
        return headers.has(book.toBase58()) ? headers.get(book.toBase58())! : null;
      },
      async getTokenAccountBalance() {
        throw new Error("RPC error: 429 Too Many Requests");
      },
      async closeBook() {
        calls.closeBook += 1;
      },
      async closeMarket() {
        calls.closeMarket += 1;
      },
    };

    await runReclaimJob({ chain }, { allSettled: true });

    expect(calls.closeBook).toBe(0);
    expect(calls.closeMarket).toBe(0);
  });

  it("fix #23: an RPC error on a balance read skips that market and closes nothing, in a dry run", async () => {
    const record = marketRecord({ book: BOOK_A }, "13");
    const headers = new Map([[BOOK_A.toBase58(), emptyHeader()]]);
    const calls = { closeBook: 0, closeMarket: 0 };
    const chain: ReclaimChain = {
      async fetchSettledMarkets() {
        return [record];
      },
      async fetchBookHeader(book: PublicKey) {
        return headers.has(book.toBase58()) ? headers.get(book.toBase58())! : null;
      },
      async getTokenAccountBalance() {
        throw new Error("RPC error: 429 Too Many Requests");
      },
      async closeBook() {
        calls.closeBook += 1;
      },
      async closeMarket() {
        calls.closeMarket += 1;
      },
    };

    await runReclaimJob({ chain }, { allSettled: true, dryRun: true });

    expect(calls.closeBook).toBe(0);
    expect(calls.closeMarket).toBe(0);
  });

  it("--day narrows to markets on that trading day only", async () => {
    const dayA = marketRecord({ book: PublicKey.default, tradingDay: 20261001 }, "10");
    const dayB = marketRecord({ book: PublicKey.default, tradingDay: 20261002 }, "11");
    const { chain, calls } = buildChain({ markets: [dayA, dayB] });

    await runReclaimJob({ chain }, { allSettled: true, day: 20261002 });

    expect(calls.closeMarket).toEqual([dayB.publicKey.toBase58()]);
  });
});
