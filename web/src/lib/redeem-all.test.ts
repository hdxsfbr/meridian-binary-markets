import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { chunk, planRedeemAll, redeemableMicro, REDEEM_ALL_CHUNK_SIZE } from "./redeem-all";
import type { PositionRowData } from "./positions-view";

function pk(seed: string): PublicKey {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < seed.length; i += 1) {
    bytes[i % 32] ^= seed.charCodeAt(i);
  }
  return new PublicKey(bytes);
}

const ONE_USDC = 1_000_000n;

function row(overrides: Partial<PositionRowData> & { marketKey: string }): PositionRowData {
  return {
    marketPubkey: pk(overrides.marketKey),
    ticker: "AAPL",
    strike: 230_000_000n,
    closeTs: 1_000n,
    state: "open",
    outcome: "unset",
    yes: 0n,
    no: 0n,
    restingYes: 0n,
    pairsHeld: 0n,
    exposure: 0n,
    costBasisMicro: 0n,
    realizedPnlMicro: 0n,
    payoutAvailableMicro: 0n,
    payoutReceivedMicro: 0n,
    canRedeemWinning: false,
    canRedeemPair: false,
    yesMint: pk("yes"),
    noMint: pk("no"),
    vault: pk("vault"),
    ...overrides,
  };
}

describe("planRedeemAll", () => {
  it("returns nothing for a wallet with no redeemable rows", () => {
    const rows = [row({ marketKey: "m1", yes: 2n, no: 0n, state: "open" })];
    expect(planRedeemAll(rows)).toEqual([]);
  });

  it("includes a winning item for a settled market with a payout", () => {
    const rows = [
      row({
        marketKey: "m1",
        state: "settled",
        outcome: "yes",
        winningSide: "yes",
        yes: 3n,
        no: 0n,
        payoutAvailableMicro: 3n * ONE_USDC,
        canRedeemWinning: true,
      }),
    ];
    expect(planRedeemAll(rows)).toEqual([{ kind: "winning", marketKey: "m1", side: "yes", qty: 3n }]);
  });

  it("includes a pair item for any market (open or settled) holding a matched pair", () => {
    const rows = [
      row({ marketKey: "open-market", yes: 2n, no: 2n, pairsHeld: 2n, canRedeemPair: true, state: "open" }),
      row({
        marketKey: "settled-market",
        state: "settled",
        outcome: "yes",
        yes: 1n,
        no: 1n,
        pairsHeld: 1n,
        canRedeemPair: true,
      }),
    ];
    expect(planRedeemAll(rows)).toEqual([
      { kind: "pair", marketKey: "open-market", qty: 2n },
      { kind: "pair", marketKey: "settled-market", qty: 1n },
    ]);
  });

  it("plans the pair first, then only the winning side's balance left over after the pair (yes=3, no=1 -> pair 1, winning 2)", () => {
    // 3 Yes total, 1 No: 1 matched into a pair (with the 1 No), leaving 2
    // Yes that are *also* winning. Redeeming the pair consumes 1 of those
    // 3 Yes, so the winning redemption must ask for only 2, not 3 -- the
    // wallet will not hold 3 Yes once the pair redemption has gone through.
    const rows = [
      row({
        marketKey: "m1",
        state: "settled",
        outcome: "yes",
        winningSide: "yes",
        yes: 3n,
        no: 1n,
        pairsHeld: 1n,
        payoutAvailableMicro: 3n * ONE_USDC,
        canRedeemWinning: true,
        canRedeemPair: true,
      }),
    ];
    expect(planRedeemAll(rows)).toEqual([
      { kind: "pair", marketKey: "m1", qty: 1n },
      { kind: "winning", marketKey: "m1", side: "yes", qty: 2n },
    ]);
  });

  it("plans only the pair when the winning side is fully consumed by it (yes=1, no=1 -> pair 1, no winning item)", () => {
    const rows = [
      row({
        marketKey: "m1",
        state: "settled",
        outcome: "yes",
        winningSide: "yes",
        yes: 1n,
        no: 1n,
        pairsHeld: 1n,
        payoutAvailableMicro: 1n * ONE_USDC,
        canRedeemWinning: true,
        canRedeemPair: true,
      }),
    ];
    expect(planRedeemAll(rows)).toEqual([{ kind: "pair", marketKey: "m1", qty: 1n }]);
  });

  it("skips a losing settled position: no winning side held, no pair", () => {
    const rows = [row({ marketKey: "m1", state: "settled", outcome: "yes", winningSide: "yes", yes: 0n, no: 2n })];
    expect(planRedeemAll(rows)).toEqual([]);
  });
});

describe("redeemableMicro", () => {
  it("is zero when nothing is redeemable", () => {
    expect(redeemableMicro([row({ marketKey: "m1", yes: 2n, no: 0n })])).toBe(0n);
  });

  it("sums winning payouts and pair value ($1 per pair) across markets", () => {
    const rows = [
      row({
        marketKey: "m1",
        state: "settled",
        outcome: "yes",
        winningSide: "yes",
        yes: 5n,
        no: 0n,
        payoutAvailableMicro: 5n * ONE_USDC,
        canRedeemWinning: true,
      }),
      row({ marketKey: "m2", pairsHeld: 2n, canRedeemPair: true }),
    ];
    expect(redeemableMicro(rows)).toBe(7n * ONE_USDC);
  });

  it("matches the corrected plan rather than the raw payout field when a pair overlaps the winning balance (yes=3, no=1 -> $3, not the raw $3 payout plus a double-counted pair)", () => {
    const rows = [
      row({
        marketKey: "m1",
        state: "settled",
        outcome: "yes",
        winningSide: "yes",
        yes: 3n,
        no: 1n,
        pairsHeld: 1n,
        payoutAvailableMicro: 3n * ONE_USDC,
        canRedeemWinning: true,
        canRedeemPair: true,
      }),
    ];
    // 1 pair ($1) + 2 remaining winning Yes ($2) = $3, matching what
    // `planRedeemAll` will actually collect, not `payoutAvailableMicro`
    // (which already counts all 3 Yes) plus another `$1` for the pair.
    expect(redeemableMicro(rows)).toBe(3n * ONE_USDC);
  });

  it("matches the corrected plan when the pair fully consumes the winning balance (yes=1, no=1 -> $1, not $2)", () => {
    const rows = [
      row({
        marketKey: "m1",
        state: "settled",
        outcome: "yes",
        winningSide: "yes",
        yes: 1n,
        no: 1n,
        pairsHeld: 1n,
        payoutAvailableMicro: 1n * ONE_USDC,
        canRedeemWinning: true,
        canRedeemPair: true,
      }),
    ];
    expect(redeemableMicro(rows)).toBe(1n * ONE_USDC);
  });
});

describe("chunk", () => {
  it("splits into groups of the given size, preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one chunk when everything fits", () => {
    expect(chunk([1, 2], 4)).toEqual([[1, 2]]);
  });

  it("returns an empty array for an empty input", () => {
    expect(chunk([], 4)).toEqual([]);
  });

  it("puts one item per chunk for a non-positive size instead of looping forever", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
  });

  it("matches the program's REDEEM_ALL_CHUNK_SIZE of 3 instructions per transaction", () => {
    const items = Array.from({ length: 9 }, (_, i) => i);
    const chunks = chunk(items, REDEEM_ALL_CHUNK_SIZE);
    expect(chunks).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
  });
});
