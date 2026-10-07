/**
 * Pure, hand-computed arithmetic for the step-6 trading scenario
 * (`scripts/lifecycle.ts`, tasks.md T086) and for picking the at-the-money
 * strike out of a ladder. Every number here is a plain `bigint` of
 * micro-USDC/micro-Yes (6 decimals), matching the program's own units
 * (`pairs_to_usdc(qty) = qty * 1_000_000`, `price` already micro-USDC per
 * whole Yes token, so a fill's USDC leg is `price * qty` with no further
 * scaling -- see `programs/meridian/src/instructions/place_order.rs`).
 *
 * This file carries no RPC/chain code (see `./chain.ts` for that) so the
 * arithmetic itself can be exercised directly in `scripts/test/lifecycle.test.ts`
 * without a validator.
 */

import type { MicroUsd, Ticker } from "@meridian/sdk";

const ONE_USDC = 1_000_000n;

export interface WalletDelta {
  usdcMicro: bigint;
  yesWhole: bigint;
  noWhole: bigint;
}

/** `price` (micro-USDC per whole Yes token) * `qty` (whole tokens) = USDC micro-units. */
export function usdcForFill(priceMicro: bigint, qtyWhole: bigint): bigint {
  return priceMicro * qtyWhole;
}

/**
 * Selects the at-the-money strike out of an already-derived ladder: the
 * element equal to `atmCandidate` (normally `atTheMoneyStrike(prevClose)`,
 * i.e. `round10(prevClose)`). Throws if the ladder doesn't contain it --
 * that would mean the ladder and the candidate were derived from different
 * previous closes, which is a caller bug, not a runtime condition to
 * tolerate silently.
 */
export function selectAtTheMoneyStrike(ladder: readonly MicroUsd[], atmCandidate: MicroUsd): MicroUsd {
  const found = ladder.find((s) => s === atmCandidate);
  if (found === undefined) {
    throw new Error(
      `selectAtTheMoneyStrike: candidate ${atmCandidate} is not a member of the ladder [${ladder.join(", ")}]`,
    );
  }
  return found;
}

/**
 * Hand-computed wallet deltas for the four maker/taker trades in
 * `lifecycle.ts` step 6, against the resting book A built (asks 5@0.60 [id
 * 1], 5@0.70 [id 2]; bid 5@0.40 [id 3]). Derived once here, by hand, in
 * order, and asserted against on-chain balances after each step (not the
 * other way around -- this file is the source of truth the live run is
 * checked against). `scripts/test/lifecycle.test.ts`'s `simulateTradePlan`
 * re-derives the same four deltas independently from `TRADE_PLAN` below and
 * checks it against these constants, so the two derivations can't silently
 * drift apart.
 *
 * Across the four trades, the 0.60 ask (id 1) is fully consumed -- 3 units
 * in Trade 1, the remaining 2 in Trade 4 -- while the 0.70 ask (id 2) is
 * never crossed at all; `lifecycle.ts` cancels it afterward (step 9),
 * refunding its untouched 5 Yes to A.
 *
 * Trade 1 -- B buys 3 Yes (market, i.e. `place_order` IOC bid at the price
 * ceiling): fills 3 @ 0.60 against A's 0.60 ask (5 resting, 2 left after).
 *   B: usdc -1.80 (= 3 * 0.60), yes +3.
 *   A: usdc +1.80, yes +0 (A's ask escrow absorbs the fill; A's own wallet
 *      balance doesn't move -- only the *escrow*, which is not a wallet).
 */
export const TRADE_1_BUY_YES: { taker: WalletDelta; maker: WalletDelta } = {
  taker: { usdcMicro: -usdcForFill(600_000n, 3n), yesWhole: 3n, noWhole: 0n },
  maker: { usdcMicro: usdcForFill(600_000n, 3n), yesWhole: 0n, noWhole: 0n },
};

/**
 * Trade 2 -- B buys 4 No (`buy_no_market`): mints 4 pairs (usdc -4.00, yes
 * +4, no +4), then IOC-sells the 4 Yes into A's resting 0.40 bid (5
 * resting, crosses all the way down to min_yes_price=0.40, fills 4, 1
 * left). Net: usdc -4.00 + 1.60 (= 4 * 0.40) = -2.40; yes +4 -4 = 0; no +4.
 *   A (maker, bid side): receives 4 Yes into its own wallet directly (the
 *   bid maker's leg in `buy_no_market` is a direct transfer, not an
 *   escrow-out to a different account) -- usdc unaffected (that draws down
 *   A's *escrow*, already deducted from A's wallet when the bid was placed).
 */
export const TRADE_2_BUY_NO: { taker: WalletDelta; maker: WalletDelta } = {
  taker: { usdcMicro: -4n * ONE_USDC + usdcForFill(400_000n, 4n), yesWhole: 0n, noWhole: 4n },
  maker: { usdcMicro: 0n, yesWhole: 4n, noWhole: 0n },
};

/**
 * Trade 3 -- B sells 1 Yes (market, i.e. `place_order` IOC ask at the price
 * floor): fills 1 @ 0.40 against A's last remaining bid unit (1 resting,
 * now fully consumed -> bid removed).
 *   B: usdc +0.40 (= 1 * 0.40), yes -1.
 *   A (maker, bid side): receives 1 Yes into its wallet; usdc unaffected
 *   (same reasoning as Trade 2 -- draws down A's escrow, not its wallet).
 */
export const TRADE_3_SELL_YES: { taker: WalletDelta; maker: WalletDelta } = {
  taker: { usdcMicro: usdcForFill(400_000n, 1n), yesWhole: -1n, noWhole: 0n },
  maker: { usdcMicro: 0n, yesWhole: 1n, noWhole: 0n },
};

/**
 * Trade 4 -- B sells 2 No (`sell_no_market`): IOC-buys 2 Yes from A's
 * remaining 0.60 ask (2 left after Trade 1's 3; exactly consumed here,
 * fully filling and removing the 0.60 ask -- all 5 of its units are now
 * accounted for, 3 in Trade 1 and 2 here), paying A directly (0.60 * 2 =
 * 1.20 USDC, maker receives straight to wallet -- `sell_no_market`'s USDC
 * leg is a direct user->maker transfer, not an escrow-out), then redeems
 * the 2 freshly-bought Yes against 2 of its own No for 2.00 USDC
 * (`redeem_pair_core`, 1 USDC per pair, no scaling).
 *   B: usdc -1.20 (pay A) + 2.00 (redeem) = +0.80; yes +2 -2 = 0; no -2.
 *   A (maker, ask side): usdc +1.20 directly; yes unaffected (A's ask
 *   escrow pays Yes to B, not A's wallet).
 */
export const TRADE_4_SELL_NO: { taker: WalletDelta; maker: WalletDelta } = {
  taker: {
    usdcMicro: -usdcForFill(600_000n, 2n) + 2n * ONE_USDC,
    yesWhole: 0n,
    noWhole: -2n,
  },
  maker: { usdcMicro: usdcForFill(600_000n, 2n), yesWhole: 0n, noWhole: 0n },
};

/**
 * Declarative description of the step-6 scenario (fix #12): A's three
 * resting quotes, in the order placed, and B's four marketable orders, in
 * the order sent. `simulateTradePlan` below replays this against a simple
 * price-time-priority book to re-derive each trade's taker/maker
 * `WalletDelta` independently of the `TRADE_1..4` hand derivations above --
 * `scripts/test/lifecycle.test.ts` asserts the two agree, so a future
 * change to the scenario (or a mistake in the by-hand comments) can't drift
 * from what the quotes/orders actually imply.
 */
export const TRADE_PLAN = {
  quotes: [
    { side: "ask", price: 600_000n, qty: 5n },
    { side: "ask", price: 700_000n, qty: 5n },
    { side: "bid", price: 400_000n, qty: 5n },
  ] as const,
  orders: [
    { kind: "buyYesMarket", qty: 3n, limitPrice: 999_999n },
    { kind: "buyNoMarket", qty: 4n, limitPrice: 400_000n },
    { kind: "sellYesMarket", qty: 1n, limitPrice: 1n },
    { kind: "sellNoMarket", qty: 2n, limitPrice: 600_000n },
  ] as const,
};

interface RestingLevel {
  price: bigint;
  remaining: bigint;
}

/**
 * Pure price-time-priority re-derivation of `TRADE_PLAN`'s four trades,
 * from first principles (no reference to `TRADE_1..4` above): builds A's
 * resting asks/bid from `TRADE_PLAN.quotes`, then replays each of B's
 * orders against them in order, mutating the same resting levels as it
 * goes (exactly as the live book does), returning one `{taker, maker}`
 * pair per order.
 */
export function simulateTradePlan(): Array<{ taker: WalletDelta; maker: WalletDelta }> {
  const asks: RestingLevel[] = TRADE_PLAN.quotes
    .filter((q) => q.side === "ask")
    .map((q) => ({ price: q.price, remaining: q.qty }))
    .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  const bids: RestingLevel[] = TRADE_PLAN.quotes
    .filter((q) => q.side === "bid")
    .map((q) => ({ price: q.price, remaining: q.qty }))
    .sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));

  const results: Array<{ taker: WalletDelta; maker: WalletDelta }> = [];

  for (const order of TRADE_PLAN.orders) {
    if (order.kind === "buyYesMarket") {
      // IOC bid: buys Yes from resting asks, ascending price, up to limitPrice.
      let remainingQty: bigint = order.qty;
      let usdcTaker = 0n;
      let yesTaker = 0n;
      let usdcMaker = 0n;
      for (const ask of asks) {
        if (remainingQty === 0n) break;
        if (ask.remaining === 0n || ask.price > order.limitPrice) continue;
        const fillQty = remainingQty < ask.remaining ? remainingQty : ask.remaining;
        usdcTaker -= usdcForFill(ask.price, fillQty);
        usdcMaker += usdcForFill(ask.price, fillQty);
        yesTaker += fillQty;
        ask.remaining -= fillQty;
        remainingQty -= fillQty;
      }
      results.push({
        taker: { usdcMicro: usdcTaker, yesWhole: yesTaker, noWhole: 0n },
        maker: { usdcMicro: usdcMaker, yesWhole: 0n, noWhole: 0n },
      });
    } else if (order.kind === "buyNoMarket") {
      // mint_pair(qty) then IOC-sell the Yes leg into resting bids, descending price, down
      // to min_yes_price (limitPrice); the bid maker receives the sold Yes directly.
      let remainingQty: bigint = order.qty;
      let usdcTaker = -order.qty * ONE_USDC;
      let yesTaker = order.qty;
      let yesMakerDirect = 0n;
      for (const bid of bids) {
        if (remainingQty === 0n) break;
        if (bid.remaining === 0n || bid.price < order.limitPrice) continue;
        const fillQty = remainingQty < bid.remaining ? remainingQty : bid.remaining;
        usdcTaker += usdcForFill(bid.price, fillQty);
        yesTaker -= fillQty;
        yesMakerDirect += fillQty;
        bid.remaining -= fillQty;
        remainingQty -= fillQty;
      }
      results.push({
        taker: { usdcMicro: usdcTaker, yesWhole: yesTaker, noWhole: order.qty },
        maker: { usdcMicro: 0n, yesWhole: yesMakerDirect, noWhole: 0n },
      });
    } else if (order.kind === "sellYesMarket") {
      // IOC ask: sells Yes into resting bids, descending price, down to limitPrice (the
      // price floor); the bid maker receives the sold Yes directly.
      let remainingQty: bigint = order.qty;
      let usdcTaker = 0n;
      let yesTaker = 0n;
      let yesMakerDirect = 0n;
      for (const bid of bids) {
        if (remainingQty === 0n) break;
        if (bid.remaining === 0n || bid.price < order.limitPrice) continue;
        const fillQty = remainingQty < bid.remaining ? remainingQty : bid.remaining;
        usdcTaker += usdcForFill(bid.price, fillQty);
        yesTaker -= fillQty;
        yesMakerDirect += fillQty;
        bid.remaining -= fillQty;
        remainingQty -= fillQty;
      }
      results.push({
        taker: { usdcMicro: usdcTaker, yesWhole: yesTaker, noWhole: 0n },
        maker: { usdcMicro: 0n, yesWhole: yesMakerDirect, noWhole: 0n },
      });
    } else {
      // sellNoMarket: IOC-buys Yes from resting asks, ascending price, up to max_yes_price
      // (limitPrice), paying the ask maker directly, then redeems the filled Yes against an
      // equal amount of its own No for 1 USDC/pair.
      let remainingQty: bigint = order.qty;
      let usdcTaker = 0n;
      let usdcMakerDirect = 0n;
      let yesBought = 0n;
      for (const ask of asks) {
        if (remainingQty === 0n) break;
        if (ask.remaining === 0n || ask.price > order.limitPrice) continue;
        const fillQty = remainingQty < ask.remaining ? remainingQty : ask.remaining;
        usdcTaker -= usdcForFill(ask.price, fillQty);
        usdcMakerDirect += usdcForFill(ask.price, fillQty);
        yesBought += fillQty;
        ask.remaining -= fillQty;
        remainingQty -= fillQty;
      }
      usdcTaker += yesBought * ONE_USDC;
      results.push({
        taker: { usdcMicro: usdcTaker, yesWhole: 0n, noWhole: -yesBought },
        maker: { usdcMicro: usdcMakerDirect, yesWhole: 0n, noWhole: 0n },
      });
    }
  }

  return results;
}

function sumDeltas(...deltas: WalletDelta[]): WalletDelta {
  return deltas.reduce(
    (acc, d) => ({
      usdcMicro: acc.usdcMicro + d.usdcMicro,
      yesWhole: acc.yesWhole + d.yesWhole,
      noWhole: acc.noWhole + d.noWhole,
    }),
    { usdcMicro: 0n, yesWhole: 0n, noWhole: 0n },
  );
}

/**
 * Net taker (B) and maker (A) wallet deltas across all four trades (step
 * 6), before A's mint/quote setup and before A's step-9 order cancellation
 * and either user's redemption. Exported so `scripts/test/lifecycle.test.ts`
 * can check the running total independent of the live run.
 */
export function netTradingDeltas(): { taker: WalletDelta; maker: WalletDelta } {
  return {
    taker: sumDeltas(TRADE_1_BUY_YES.taker, TRADE_2_BUY_NO.taker, TRADE_3_SELL_YES.taker, TRADE_4_SELL_NO.taker),
    maker: sumDeltas(TRADE_1_BUY_YES.maker, TRADE_2_BUY_NO.maker, TRADE_3_SELL_YES.maker, TRADE_4_SELL_NO.maker),
  };
}

/**
 * Full hand-computed P&L for the step 5-9 scenario (PRD §7: "one user
 * mints and quotes, another takes, and both redeem"), expressed as the net
 * USDC delta from each user's *initial funded balance* to its *final*
 * balance (after settlement and redemption), in micro-USDC. Derivation:
 *
 * A (maker): mints 20 pairs (-20.00), escrows a 5@0.40 bid (-2.00) ->
 * wallet -22.00. Trades settle A's wallet usdc at -22.00 + 1.80 (Trade 1)
 * + 0 (Trade 2, escrow-only) + 0 (Trade 3, escrow-only) + 1.20 (Trade 4) =
 * -19.00. Cancelling the untouched 0.70 ask (never crossed) refunds Yes,
 * not USDC, so cancellation doesn't move A's USDC.
 *
 * A ends holding exactly 20 Yes and 20 No (hedged). Yes bookkeeping: starts
 * with 20 from `mint_pair`, escrows 5 into the 0.60 ask (id 1) and 5 into
 * the 0.70 ask (id 2), leaving 10 in wallet. The 0.60 ask is fully consumed
 * across Trade 1 (3) and Trade 4 (2) -- escrow-only, A's wallet balance
 * doesn't move for either fill. Trades 2 and 3 fill against A's bid and pay
 * A directly: +4 Yes (Trade 2) and +1 Yes (Trade 3) land in A's wallet,
 * bringing it to 10 + 4 + 1 = 15. The 0.70 ask (id 2) is never crossed;
 * cancelling it (step 9) refunds its untouched 5 Yes to A's wallet, for a
 * final 15 + 5 = 20 Yes. No never moves for A during trading (it's only
 * escrowed/transferred on the Yes leg above), so A's No stays at the 20
 * minted. Cross-checked live against on-chain balances after every
 * instruction in `scripts/lifecycle.ts`. Settlement resolves Yes (price =
 * strike + $5). `redeem_winning` on A's 20 Yes pays 20.00 USDC: final delta
 * = -19.00 + 20.00 = +1.00 USDC.
 *
 * B (taker): Trade 1 -1.80, Trade 2 -2.40, Trade 3 +0.40, Trade 4 +0.80 =
 * net -3.00 USDC, ending with exactly 2 Yes and 2 No (hedged).redeem_winning
 * on 2 Yes pays 2.00 USDC: final delta = -3.00 + 2.00 = -1.00 USDC.
 *
 * Zero-sum check: A's +1.00 and B's -1.00 net to 0 -- the spread A quoted
 * (0.60/0.40, A's own ask/bid) is exactly the $1.00 B paid for taking
 * liquidity across the four trades, nothing lost or created.
 */
export const EXPECTED_FINAL_PNL_MICRO_USDC = {
  maker: 1_000_000n,
  taker: -1_000_000n,
} as const;

export interface LifecycleReportInput {
  cluster: "localnet" | "devnet";
  programId: string;
  configAddress: string;
  tradingDay: number;
  tickers: Ticker[];
  markets: Array<{ ticker: Ticker; strike: bigint; market: string; state: string; outcome: string }>;
  rentSolPerMarket: number;
  rentSolTotal: number;
  userA: { address: string; initialUsdcMicro: bigint; finalUsdcMicro: bigint };
  userB: { address: string; initialUsdcMicro: bigint; finalUsdcMicro: bigint };
  vaultFinalMicro: bigint;
  wallClockMs: number;
}

function usdc(micro: bigint): string {
  const sign = micro < 0n ? "-" : "";
  const abs = micro < 0n ? -micro : micro;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${sign}${whole}.${frac}`;
}

/**
 * Formats the final human-readable table (brief deliverable 1, step 10):
 * program id / config PDA / all market addresses, then SOL-rent and USDC
 * flow summary. Pure (no I/O) so it can be unit-tested and reused by both
 * the CLI's `console.log` and the integration test's assertions.
 */
export function formatLifecycleReport(input: LifecycleReportInput): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("lifecycle: final report");
  lines.push(`  cluster:        ${input.cluster}`);
  lines.push(`  program id:     ${input.programId}`);
  lines.push(`  config PDA:     ${input.configAddress}`);
  lines.push(`  trading day:    ${input.tradingDay}`);
  lines.push(`  tickers:        ${input.tickers.join(", ")}`);
  lines.push("");
  lines.push("  Markets:");
  for (const m of input.markets) {
    lines.push(
      `    ${m.ticker.padEnd(6)} strike=${usdc(m.strike).padStart(10)} ${m.market} state=${m.state} outcome=${m.outcome}`,
    );
  }
  lines.push("");
  lines.push("  Rent:");
  lines.push(`    per market: ${input.rentSolPerMarket.toFixed(6)} SOL`);
  lines.push(`    total:      ${input.rentSolTotal.toFixed(6)} SOL (${input.markets.length} markets)`);
  lines.push("");
  lines.push("  USDC flows (initial -> final, delta):");
  const deltaA = input.userA.finalUsdcMicro - input.userA.initialUsdcMicro;
  const deltaB = input.userB.finalUsdcMicro - input.userB.initialUsdcMicro;
  lines.push(
    `    A (maker) ${input.userA.address}: ${usdc(input.userA.initialUsdcMicro)} -> ${usdc(input.userA.finalUsdcMicro)} (${deltaA >= 0n ? "+" : ""}${usdc(deltaA)})`,
  );
  lines.push(
    `    B (taker) ${input.userB.address}: ${usdc(input.userB.initialUsdcMicro)} -> ${usdc(input.userB.finalUsdcMicro)} (${deltaB >= 0n ? "+" : ""}${usdc(deltaB)})`,
  );
  lines.push(`    traded market vault (final): ${usdc(input.vaultFinalMicro)} USDC`);
  lines.push("");
  lines.push(`  wall clock: ${(input.wallClockMs / 1000).toFixed(1)}s`);
  lines.push("");
  return lines.join("\n");
}
