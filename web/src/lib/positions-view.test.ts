import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { Position } from "@meridian/sdk";
import { buildPositionRows, countFillsByMarket, type AvailableBalance, type MarketLike } from "./positions-view";

/** Builds the `available` map `buildPositionRows` takes, from `{ marketKey: {yes, no} }` pairs. */
function availableMap(entries: Array<[PublicKey, AvailableBalance]>): Map<string, AvailableBalance> {
  return new Map(entries.map(([key, balance]) => [key.toBase58(), balance]));
}

/** Builds the `restingYes` map `buildPositionRows` takes, from `{ marketKey: qty }` pairs. */
function restingMap(entries: Array<[PublicKey, bigint]>): Map<string, bigint> {
  return new Map(entries.map(([key, qty]) => [key.toBase58(), qty]));
}

const NO_RESTING = restingMap([]);

function pk(seed: string): PublicKey {
  // Deterministic 32-byte "address" derived from a short seed string, for
  // readable test fixtures (no real keypair needed for pure view-model tests).
  const bytes = new Uint8Array(32);
  for (let i = 0; i < seed.length; i += 1) {
    bytes[i % 32] ^= seed.charCodeAt(i);
  }
  return new PublicKey(bytes);
}

function market(overrides: Partial<MarketLike> & { pubkey: PublicKey }): MarketLike {
  return {
    ticker: "META",
    strike: 680_000_000n,
    closeTs: 1_000n,
    state: "open",
    outcome: "unset",
    settlementPrice: 0n,
    yesMint: pk("yes"),
    noMint: pk("no"),
    vault: pk("vault"),
    yesNoTokenProgram: pk("token-program"),
    ...overrides,
  };
}

function position(marketKey: PublicKey, overrides: Partial<Position>): Position {
  return {
    market: marketKey,
    yes: 0n,
    no: 0n,
    mintedPairs: 0n,
    costBasisMicro: 0n,
    realizedPnlMicro: 0n,
    ...overrides,
  };
}

describe("buildPositionRows", () => {
  it("shows an open position (no settlement, not redeemable either way)", () => {
    const m = pk("m-open");
    const positions = new Map([[m.toBase58(), position(m, { costBasisMicro: 2_000_000n })]]);
    const markets = [market({ pubkey: m })];
    const available = availableMap([[m, { yes: 5n, no: 0n }]]);

    const rows = buildPositionRows(positions, markets, available, NO_RESTING);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "open",
      yes: 5n,
      no: 0n,
      pairsHeld: 0n,
      canRedeemWinning: false,
      canRedeemPair: false,
    });
  });

  it("settled Yes with only the losing (No) side held: not redeemable", () => {
    const m = pk("m-settled-no-held");
    const markets = [market({ pubkey: m, state: "settled", outcome: "yes", settlementPrice: 1_000_000n })];
    const available = availableMap([[m, { yes: 0n, no: 5n }]]);

    const rows = buildPositionRows(new Map(), markets, available, NO_RESTING);

    expect(rows).toHaveLength(1);
    expect(rows[0].canRedeemWinning).toBe(false);
    expect(rows[0].payoutAvailableMicro).toBe(0n);
  });

  it("settled Yes with the winning (Yes) side held: redeemable, payout = qty * $1", () => {
    const m = pk("m-settled-yes-held");
    const markets = [market({ pubkey: m, state: "settled", outcome: "yes", settlementPrice: 1_000_000n })];
    const available = availableMap([[m, { yes: 7n, no: 0n }]]);

    const rows = buildPositionRows(new Map(), markets, available, NO_RESTING);

    expect(rows).toHaveLength(1);
    expect(rows[0].canRedeemWinning).toBe(true);
    expect(rows[0].winningSide).toBe("yes");
    expect(rows[0].payoutAvailableMicro).toBe(7_000_000n);
  });

  it("a matched pair is redeemable as a pair in any market state", () => {
    const openMarketKey = pk("m-pair-open");
    const settledMarketKey = pk("m-pair-settled");
    const markets = [
      market({ pubkey: openMarketKey, ticker: "AAPL", strike: 1n }),
      market({ pubkey: settledMarketKey, ticker: "AAPL", strike: 2n, state: "settled", outcome: "no" }),
    ];
    const available = availableMap([
      [openMarketKey, { yes: 3n, no: 3n }],
      [settledMarketKey, { yes: 4n, no: 4n }],
    ]);

    const rows = buildPositionRows(new Map(), markets, available, NO_RESTING);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.pairsHeld).toBe(row.state === "open" ? 3n : 4n);
      expect(row.canRedeemPair).toBe(true);
    }
  });

  it("omits markets with no available balance and no resting Yes", () => {
    const touched = pk("m-touched");
    const zeroed = pk("m-zeroed");
    const markets = [market({ pubkey: touched }), market({ pubkey: zeroed, ticker: "TSLA" })];
    const positions = new Map([[zeroed.toBase58(), position(zeroed, { realizedPnlMicro: 500_000n })]]);
    const available = availableMap([
      [touched, { yes: 1n, no: 0n }],
      [zeroed, { yes: 0n, no: 0n }],
    ]);

    const rows = buildPositionRows(positions, markets, available, NO_RESTING);

    expect(rows.map((r) => r.marketKey)).toEqual([touched.toBase58()]);
  });

  it("drops a position whose market account was not supplied", () => {
    const missing = pk("m-missing");
    const available = availableMap([[missing, { yes: 1n, no: 0n }]]);

    expect(buildPositionRows(new Map(), [], available, NO_RESTING)).toHaveLength(0);
  });

  it("shows resting Yes even with zero available balance (escrowed, not held)", () => {
    const m = pk("m-resting");
    const markets = [market({ pubkey: m })];
    const available = availableMap([[m, { yes: 0n, no: 2n }]]);
    const restingYes = restingMap([[m, 2n]]);

    const rows = buildPositionRows(new Map(), markets, available, restingYes);

    expect(rows).toHaveLength(1);
    expect(rows[0].restingYes).toBe(2n);
    expect(rows[0].yes).toBe(0n);
    expect(rows[0].no).toBe(2n);
  });

  it("sorts open before settled, then by close time, ticker, and strike", () => {
    const a = pk("sort-a");
    const b = pk("sort-b");
    const c = pk("sort-c");
    const d = pk("sort-d");
    const markets = [
      market({ pubkey: a, ticker: "META", strike: 2n, closeTs: 500n, state: "settled", outcome: "yes" }),
      market({ pubkey: b, ticker: "META", strike: 1n, closeTs: 500n }),
      market({ pubkey: c, ticker: "AAPL", strike: 1n, closeTs: 100n }),
      market({ pubkey: d, ticker: "AAPL", strike: 1n, closeTs: 50n }),
    ];
    const available = availableMap([
      [a, { yes: 1n, no: 0n }],
      [b, { yes: 1n, no: 0n }],
      [c, { yes: 1n, no: 0n }],
      [d, { yes: 1n, no: 0n }],
    ]);

    const rows = buildPositionRows(new Map(), markets, available, NO_RESTING);

    expect(rows.map((r) => r.marketKey)).toEqual([
      d.toBase58(), // open, closeTs 50
      c.toBase58(), // open, closeTs 100
      b.toBase58(), // open, closeTs 500
      a.toBase58(), // settled, last
    ]);
  });
});

describe("countFillsByMarket", () => {
  it("counts a Fill once per event for the wallet, whether maker or taker, and ignores others", () => {
    const wallet = pk("wallet");
    const other = pk("other");
    const marketA = pk("market-a");
    const marketB = pk("market-b");

    const events = [
      {
        name: "Fill" as const,
        data: {
          market: marketA,
          makerOrderId: 1n,
          maker: wallet,
          taker: other,
          sideOfTaker: 0,
          price: 500_000n,
          qty: 1n,
          ts: 1n,
        },
        slot: 1,
        signature: "sig1",
      },
      {
        name: "Fill" as const,
        data: {
          market: marketA,
          makerOrderId: 2n,
          maker: other,
          taker: wallet,
          sideOfTaker: 1,
          price: 500_000n,
          qty: 1n,
          ts: 2n,
        },
        slot: 2,
        signature: "sig2",
      },
      {
        name: "Fill" as const,
        data: {
          market: marketB,
          makerOrderId: 3n,
          maker: other,
          taker: other,
          sideOfTaker: 0,
          price: 500_000n,
          qty: 1n,
          ts: 3n,
        },
        slot: 3,
        signature: "sig3",
      },
      {
        name: "Minted" as const,
        data: { market: marketA, user: wallet, qty: 1n },
        slot: 4,
        signature: "sig4",
      },
    ];

    const counts = countFillsByMarket(events as never, wallet);

    expect(counts.get(marketA.toBase58())).toBe(2);
    expect(counts.has(marketB.toBase58())).toBe(false);
  });
});
