import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { MeridianEvent } from "../src/events";
import { buildPositions, summarize } from "../src/pnl";
import { Side } from "../src/types";

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

const WALLET = pk(1);
const COUNTERPARTY = pk(2);
const MARKET = pk(10);

function minted(market: PublicKey, user: PublicKey, qty: bigint, slot = 1): MeridianEvent {
  return { name: "Minted", data: { market, user, qty }, slot, signature: `sig-${slot}` };
}

function pairRedeemed(market: PublicKey, user: PublicKey, qty: bigint, slot = 1): MeridianEvent {
  return { name: "PairRedeemed", data: { market, user, qty }, slot, signature: `sig-${slot}` };
}

function fill(
  market: PublicKey,
  opts: { maker: PublicKey; taker: PublicKey; sideOfTaker: Side; price: bigint; qty: bigint },
  slot = 1,
): MeridianEvent {
  return {
    name: "Fill",
    data: {
      market,
      makerOrderId: 1n,
      maker: opts.maker,
      taker: opts.taker,
      sideOfTaker: opts.sideOfTaker,
      price: opts.price,
      qty: opts.qty,
      ts: 0n,
    },
    slot,
    signature: `sig-${slot}`,
  };
}

function settled(market: PublicKey, price: bigint, outcome: 1 | 2, slot = 1): MeridianEvent {
  return { name: "Settled", data: { market, price, outcome, byOverride: false, ts: 0n }, slot, signature: `sig-${slot}` };
}

function winningRedeemed(
  market: PublicKey,
  user: PublicKey,
  side: 1 | 2,
  qty: bigint,
  payout: bigint,
  slot = 1,
): MeridianEvent {
  return { name: "WinningRedeemed", data: { market, user, side, qty, payout }, slot, signature: `sig-${slot}` };
}

describe("buildPositions", () => {
  it("mint 10 pairs at $1, then sell all 10 Yes at 0.65: realized = 1,500,000", () => {
    // Mint splits the $1/pair 50/50 across the Yes and No legs (pnl.ts doc
    // comment): costYes = costNo = 10 * 500_000 = 5_000_000.
    // Selling 10 Yes at 650_000/unit: proceeds = 10 * 650_000 = 6_500_000.
    // costRemoved (all of the Yes leg) = 5_000_000.
    // realized = 6_500_000 - 5_000_000 = 1_500_000.
    const events: MeridianEvent[] = [
      minted(MARKET, WALLET, 10n, 1),
      fill(MARKET, { maker: COUNTERPARTY, taker: WALLET, sideOfTaker: Side.Ask, price: 650_000n, qty: 10n }, 2),
    ];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    expect(pos!.yes).toBe(0n);
    expect(pos!.no).toBe(10n);
    expect(pos!.mintedPairs).toBe(10n);
    expect(pos!.realizedPnlMicro).toBe(1_500_000n);
    // Remaining cost basis is just the untouched No leg: 10 * 500_000.
    expect(pos!.costBasisMicro).toBe(5_000_000n);
  });

  it("buy 5 Yes at 0.40, market settles Yes, redeem 5: realized = 5 * (1_000_000 - 400_000)", () => {
    // Buying 5 Yes at 400_000/unit: costYes = 5 * 400_000 = 2_000_000.
    // WinningRedeemed burns all 5 Yes; payout = 5 * 1_000_000 = 5_000_000
    // (on-chain `pairs_to_usdc`); costRemoved = all of costYes = 2_000_000.
    // realized = 5_000_000 - 2_000_000 = 3_000_000 = 5 * 600_000.
    const events: MeridianEvent[] = [
      fill(MARKET, { maker: COUNTERPARTY, taker: WALLET, sideOfTaker: Side.Bid, price: 400_000n, qty: 5n }, 1),
      settled(MARKET, 151_000_000n, 1, 2),
      winningRedeemed(MARKET, WALLET, 1, 5n, 5_000_000n, 3),
    ];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    expect(pos!.yes).toBe(0n);
    expect(pos!.realizedPnlMicro).toBe(5n * (1_000_000n - 400_000n));
    expect(pos!.realizedPnlMicro).toBe(3_000_000n);
    expect(pos!.costBasisMicro).toBe(0n);
    expect(pos!.settled).toEqual({ price: 151_000_000n, outcome: 1, payoutMicro: 5_000_000n });
  });

  it("LP case: mint 10, post nothing, redeem all 10 pairs: realized = 0", () => {
    const events: MeridianEvent[] = [minted(MARKET, WALLET, 10n, 1), pairRedeemed(MARKET, WALLET, 10n, 2)];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    expect(pos!.yes).toBe(0n);
    expect(pos!.no).toBe(0n);
    expect(pos!.mintedPairs).toBe(0n);
    expect(pos!.costBasisMicro).toBe(0n);
    expect(pos!.realizedPnlMicro).toBe(0n);
  });

  it("No-side case: wallet mints 1 pair then is the maker of a resting bid, filled by a taker sell (selling Yes to hold No)", () => {
    // Mint 1 pair: costYes = costNo = 500_000.
    // Fill: taker sells Yes (sideOfTaker = Ask) against the wallet's resting
    // bid, so the wallet (maker) is on the other side: walletAction = Bid =
    // buying more Yes, qty 1 at 300_000. This is the event stream's only way
    // to express "the wallet wants more Yes exposure while already holding a
    // complementary No from the mint" -- there is no separate No-trade event.
    // yes = 1(mint) + 1(fill) = 2; costYes = 500_000 + 300_000 = 800_000.
    const events: MeridianEvent[] = [
      minted(MARKET, WALLET, 1n, 1),
      fill(MARKET, { maker: WALLET, taker: COUNTERPARTY, sideOfTaker: Side.Ask, price: 300_000n, qty: 1n }, 2),
    ];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    expect(pos!.yes).toBe(2n);
    expect(pos!.no).toBe(1n);
    expect(pos!.realizedPnlMicro).toBe(0n);
    expect(pos!.costBasisMicro).toBe(800_000n + 500_000n);
  });

  it("No-side case: wallet is the maker of a resting ask, filled by a taker buy (selling Yes, keeping the minted No)", () => {
    // Mint 1 pair: costYes = costNo = 500_000, yes = no = 1.
    // Fill: taker buys Yes (sideOfTaker = Bid) against the wallet's resting
    // ask, so the wallet (maker) is selling: walletAction = Ask, qty 1 at
    // 700_000. costRemoved = all of costYes (500_000).
    // realized = 700_000 - 500_000 = 200_000. The retained No token's
    // minted-cost basis (500_000) is unchanged -- see pnl.ts's doc comment on
    // why this module does not re-price it to the 1_000_000 - 700_000
    // complement: no on-chain event prices the No leg directly.
    const events: MeridianEvent[] = [
      minted(MARKET, WALLET, 1n, 1),
      fill(MARKET, { maker: WALLET, taker: COUNTERPARTY, sideOfTaker: Side.Bid, price: 700_000n, qty: 1n }, 2),
    ];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    expect(pos!.yes).toBe(0n);
    expect(pos!.no).toBe(1n);
    expect(pos!.realizedPnlMicro).toBe(200_000n);
    expect(pos!.costBasisMicro).toBe(500_000n);
  });

  it("ignores events for other wallets and non-position event kinds", () => {
    const otherWallet = pk(99);
    const events: MeridianEvent[] = [
      minted(MARKET, otherWallet, 10n, 1),
      { name: "MarketCreated", data: { market: MARKET, ticker: "AAPL", strike: 1n, tradingDay: 1, closeTs: 1n }, slot: 0, signature: "s" },
      { name: "OrderPlaced", data: { market: MARKET, orderId: 1n, owner: WALLET, side: Side.Bid, price: 1n, qty: 1n }, slot: 0, signature: "s" },
      { name: "OrderCancelled", data: { market: MARKET, orderId: 1n, owner: WALLET, remainingRefunded: 1n }, slot: 0, signature: "s" },
      { name: "Paused", data: { admin: WALLET, ts: 0n }, slot: 0, signature: "s" },
      { name: "Unpaused", data: { admin: WALLET, ts: 0n }, slot: 0, signature: "s" },
    ];
    const positions = buildPositions(events, WALLET);
    expect(positions.size).toBe(0);
  });
});

describe("buildPositions: redeem_pair proportional-cost rework", () => {
  it("Codex scenario (a): mint 1 pair, sell Yes @0.65, buy Yes @0.40, redeem pair -> realized +0.25, basis 0", () => {
    // Mint 1 pair: costYes = costNo = 500_000, yes = no = 1.
    // Sell 1 Yes @650_000: costRemoved = 500_000 (all of Yes leg);
    //   realized += 650_000 - 500_000 = 150_000. costYes = 0, yes = 0.
    // Buy 1 Yes @400_000: costYes = 400_000, yes = 1.
    // Redeem 1 pair: costYesRemoved = 400_000 (all of Yes leg, yes=1);
    //   costNoRemoved = 500_000 (all of No leg, no=1, untouched since mint).
    //   realized += 1_000_000 - (400_000 + 500_000) = 100_000.
    // Total realized = 150_000 + 100_000 = 250_000 = $0.25; final basis 0.
    const events: MeridianEvent[] = [
      minted(MARKET, WALLET, 1n, 1),
      fill(MARKET, { maker: COUNTERPARTY, taker: WALLET, sideOfTaker: Side.Ask, price: 650_000n, qty: 1n }, 2),
      fill(MARKET, { maker: COUNTERPARTY, taker: WALLET, sideOfTaker: Side.Bid, price: 400_000n, qty: 1n }, 3),
      pairRedeemed(MARKET, WALLET, 1n, 4),
    ];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    expect(pos!.yes).toBe(0n);
    expect(pos!.no).toBe(0n);
    expect(pos!.realizedPnlMicro).toBe(250_000n);
    expect(pos!.costBasisMicro).toBe(0n);
  });

  it("Codex scenario (b): mint 1 pair, settle Yes, redeem winner -> realized 0 (not +0.50)", () => {
    // Mint 1 pair: costYes = costNo = 500_000, yes = no = 1.
    // Settled(outcome=Yes): writes off the No leg's 500_000 basis as a
    //   realized loss once: realized = -500_000, costNo = 0.
    // WinningRedeemed(side=Yes, qty=1, payout=1_000_000): costRemoved =
    //   500_000 (all of Yes leg); realized += 1_000_000 - 500_000 = 500_000.
    // Total realized = -500_000 + 500_000 = 0.
    const events: MeridianEvent[] = [
      minted(MARKET, WALLET, 1n, 1),
      settled(MARKET, 151_000_000n, 1, 2),
      winningRedeemed(MARKET, WALLET, 1, 1n, 1_000_000n, 3),
    ];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    expect(pos!.yes).toBe(0n);
    expect(pos!.no).toBe(1n);
    expect(pos!.realizedPnlMicro).toBe(0n);
    expect(pos!.costBasisMicro).toBe(0n);
  });

  it("writes off the losing leg's basis exactly once even if Settled is observed twice", () => {
    const events: MeridianEvent[] = [
      minted(MARKET, WALLET, 1n, 1),
      settled(MARKET, 151_000_000n, 1, 2),
      settled(MARKET, 151_000_000n, 1, 3),
    ];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    // Only one write-off of the 500_000 No-leg basis, not two.
    expect(pos!.realizedPnlMicro).toBe(-500_000n);
    expect(pos!.costBasisMicro).toBe(500_000n); // Yes leg untouched.
  });

  it("a self-fill (wallet is both maker and taker) changes nothing", () => {
    const events: MeridianEvent[] = [
      minted(MARKET, WALLET, 1n, 1),
      fill(MARKET, { maker: WALLET, taker: WALLET, sideOfTaker: Side.Bid, price: 600_000n, qty: 1n }, 2),
    ];
    const positions = buildPositions(events, WALLET);
    const pos = positions.get(MARKET.toBase58());
    expect(pos).toBeDefined();
    expect(pos!.yes).toBe(1n);
    expect(pos!.no).toBe(1n);
    expect(pos!.realizedPnlMicro).toBe(0n);
    expect(pos!.costBasisMicro).toBe(1_000_000n);
  });
});

describe("summarize", () => {
  it("sums every field across all markets", () => {
    const marketB = pk(20);
    const events: MeridianEvent[] = [
      minted(MARKET, WALLET, 10n, 1),
      pairRedeemed(MARKET, WALLET, 4n, 2),
      minted(marketB, WALLET, 3n, 1),
    ];
    const positions = buildPositions(events, WALLET);
    const total = summarize(positions);
    // Market A: yes=no=6, mintedPairs=6, cost = 6 * 1_000_000 = 6_000_000.
    // Market B: yes=no=3, mintedPairs=3, cost = 3 * 1_000_000 = 3_000_000.
    expect(total.yes).toBe(9n);
    expect(total.no).toBe(9n);
    expect(total.mintedPairs).toBe(9n);
    expect(total.costBasisMicro).toBe(9_000_000n);
    expect(total.realizedPnlMicro).toBe(0n);
  });

  it("accepts a plain iterable of positions too", () => {
    const events: MeridianEvent[] = [minted(MARKET, WALLET, 2n, 1)];
    const positions = buildPositions(events, WALLET);
    const total = summarize(positions.values());
    expect(total.yes).toBe(2n);
  });
});
