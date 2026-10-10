/**
 * Pure view-model layer for the Portfolio page: merges a wallet's current
 * on-chain inventory -- *available* Yes/No token balances and *escrowed*
 * (resting-ask) Yes -- with its reconstructed cost basis / realized P&L
 * (`@meridian/sdk`'s `pnl.ts`, folded from the event stream) and the
 * `Market` accounts they refer to, into display-ready rows. No React, no
 * RPC, no localStorage here -- `usePositions.ts` is the hook that wires
 * this to the network; this module is unit-tested on its own in
 * `positions-view.test.ts`.
 *
 * Item 5: `yes`/`no`/`pairsHeld`/`canRedeemPair` are always derived from
 * *available* balances (the wallet's Yes/No associated token accounts),
 * never from the event-derived `Position` -- an order resting on the book
 * has already moved its Yes into escrow, so it is not available to redeem
 * or trade, even though the wallet "holds" it in the sense the event log
 * would suggest. The event-derived `Position` map is used *only* for
 * `costBasisMicro`/`realizedPnlMicro` here.
 *
 * Copy rule (contracts/frontend.md): a minted, still-matched pair is shown
 * as one "Minted pair" line, never as two separate Yes/No positions. This
 * module expresses that as `pairsHeld = min(yes, no)`; the page/components
 * layer is responsible for rendering it as a single line.
 */

import type { PublicKey } from "@solana/web3.js";
import { ONE_USDC } from "@meridian/sdk";
import type { MeridianEvent, Position } from "@meridian/sdk";

/** The subset of a decoded `Market` account this module needs; kept independent of `useMarkets`'s type so this stays React-free. */
export type MarketLike = {
  pubkey: PublicKey;
  ticker: string;
  strike: bigint;
  /** `YYYYMMDD`; optional so older fixtures without it still type-check. */
  tradingDay?: number;
  closeTs: bigint;
  state: "open" | "settled";
  outcome: "unset" | "yes" | "no";
  /** Micro-USD; meaningful only once `state === "settled"`. */
  settlementPrice: bigint;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  /** Owning token program of `yesMint`/`noMint` -- classic SPL Token for a legacy market, Token-2022 for one created after the migration. */
  yesNoTokenProgram: PublicKey;
  /**
   * True when `yesNoTokenProgram` has never actually been verified against
   * chain for this market (every lookup attempt failed and no prior
   * successful lookup exists to fall back on) -- `yesNoTokenProgram` is a
   * placeholder in that case, not a confirmed value. Optional/defaults to
   * `false` so existing fixtures that never set it keep type-checking.
   */
  yesNoTokenProgramUnknown?: boolean;
};

/** One market's row in the Portfolio view, derived from a `Position` + its `Market`. */
export type PositionRowData = {
  marketPubkey: PublicKey;
  marketKey: string;
  ticker: string;
  strike: bigint;
  /** `YYYYMMDD`, when the market carried it. */
  tradingDay?: number;
  closeTs: bigint;
  state: "open" | "settled";
  outcome: "unset" | "yes" | "no";
  /** Yes tokens available in the wallet's ATA (whole contracts) -- excludes anything resting as an escrowed ask. */
  yes: bigint;
  /** No tokens available in the wallet's ATA (whole contracts). */
  no: bigint;
  /** Yes resting on the book as this wallet's own ask (escrowed, not available), whole contracts. */
  restingYes: bigint;
  /** `min(yes, no)`: the still-matched, available portion, shown as "Minted pair". */
  pairsHeld: bigint;
  /** `yes - no` (available balances); the market-maker's net directional exposure for this strike. */
  exposure: bigint;
  costBasisMicro: bigint;
  realizedPnlMicro: bigint;
  /** Only present once `state === "settled"`. */
  settlementPriceMicro?: bigint;
  /** Only present once `state === "settled"` and the outcome is decided. */
  winningSide?: "yes" | "no";
  /** What pressing "Redeem winning" right now would pay out, micro-USDC (0 if not applicable). */
  payoutAvailableMicro: bigint;
  /** Cumulative payout already received via past `WinningRedeemed` calls, micro-USDC. */
  payoutReceivedMicro: bigint;
  /** FR-022: holds the winning side's tokens, with something to redeem. */
  canRedeemWinning: boolean;
  /** FR-006/034: redeemable in any market state, paused or not. */
  canRedeemPair: boolean;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  /** Owning token program of `yesMint`/`noMint` (see `MarketLike`). */
  yesNoTokenProgram: PublicKey;
  /** See `MarketLike.yesNoTokenProgramUnknown`; when true, `canRedeemWinning`/`canRedeemPair` are forced `false` -- a builder must never derive an ATA from this row's `yesNoTokenProgram`. */
  yesNoTokenProgramUnknown?: boolean;
};

function sortRows(a: PositionRowData, b: PositionRowData): number {
  if (a.state !== b.state) {
    return a.state === "open" ? -1 : 1;
  }
  if (a.closeTs !== b.closeTs) {
    return a.closeTs < b.closeTs ? -1 : 1;
  }
  if (a.ticker !== b.ticker) {
    return a.ticker < b.ticker ? -1 : 1;
  }
  if (a.strike !== b.strike) {
    return a.strike < b.strike ? -1 : 1;
  }
  return 0;
}

/** A wallet's available (ATA) Yes/No balance for one market, whole contracts. */
export type AvailableBalance = { yes: bigint; no: bigint };

const ZERO_BALANCE: AvailableBalance = { yes: 0n, no: 0n };
const ZERO_POSITION_COST: Pick<Position, "costBasisMicro" | "realizedPnlMicro" | "settled"> = {
  costBasisMicro: 0n,
  realizedPnlMicro: 0n,
  settled: undefined,
};

/**
 * Builds one row per market the wallet has something to show for -- a
 * nonzero available Yes/No balance, or Yes resting as its own ask -- sorted
 * open-before-settled, then by closing time, ticker, and strike.
 *
 * `available` and `restingYes` (item 5) are read straight from the chain
 * (the wallet's Yes/No ATAs and the market's `Book`); `positions` (the
 * event-derived fold) supplies only `costBasisMicro`/`realizedPnlMicro`,
 * defaulting to zero for a market with inventory but no cached history yet.
 */
export function buildPositionRows(
  positions: ReadonlyMap<string, Position>,
  markets: readonly MarketLike[],
  available: ReadonlyMap<string, AvailableBalance>,
  restingYes: ReadonlyMap<string, bigint>,
): PositionRowData[] {
  const marketsByKey = new Map<string, MarketLike>();
  for (const market of markets) {
    marketsByKey.set(market.pubkey.toBase58(), market);
  }

  const keys = new Set<string>([...available.keys(), ...restingYes.keys()]);

  const rows: PositionRowData[] = [];
  for (const key of keys) {
    const balance = available.get(key) ?? ZERO_BALANCE;
    const resting = restingYes.get(key) ?? 0n;
    if (balance.yes === 0n && balance.no === 0n && resting === 0n) {
      continue;
    }
    const market = marketsByKey.get(key);
    if (!market) {
      continue;
    }
    const pos = positions.get(key);
    const costBasisMicro = pos?.costBasisMicro ?? ZERO_POSITION_COST.costBasisMicro;
    const realizedPnlMicro = pos?.realizedPnlMicro ?? ZERO_POSITION_COST.realizedPnlMicro;
    const payoutReceivedMicro = pos?.settled?.payoutMicro ?? 0n;

    const pairsHeld = balance.yes < balance.no ? balance.yes : balance.no;
    const exposure = balance.yes - balance.no;
    const settled = market.state === "settled";
    const winningSide = settled && market.outcome !== "unset" ? market.outcome : undefined;

    let payoutAvailableMicro = 0n;
    if (winningSide === "yes" && balance.yes > 0n) {
      payoutAvailableMicro = balance.yes * ONE_USDC;
    } else if (winningSide === "no" && balance.no > 0n) {
      payoutAvailableMicro = balance.no * ONE_USDC;
    }

    rows.push({
      marketPubkey: market.pubkey,
      marketKey: key,
      ticker: market.ticker,
      strike: market.strike,
      tradingDay: market.tradingDay,
      closeTs: market.closeTs,
      state: market.state,
      outcome: market.outcome,
      yes: balance.yes,
      no: balance.no,
      restingYes: resting,
      pairsHeld,
      exposure,
      costBasisMicro,
      realizedPnlMicro,
      settlementPriceMicro: settled ? market.settlementPrice : undefined,
      winningSide,
      payoutAvailableMicro,
      payoutReceivedMicro,
      // A market whose Yes/No token program was never actually verified
      // must not offer a redeem action: both builders derive the user's
      // Yes/No ATA from `yesNoTokenProgram`, which is a guess (not a
      // confirmed value) in that state (item 3 of the Token-2022 audit).
      canRedeemWinning: !market.yesNoTokenProgramUnknown && payoutAvailableMicro > 0n,
      canRedeemPair: !market.yesNoTokenProgramUnknown && pairsHeld > 0n,
      yesMint: market.yesMint,
      noMint: market.noMint,
      vault: market.vault,
      yesNoTokenProgram: market.yesNoTokenProgram,
      yesNoTokenProgramUnknown: market.yesNoTokenProgramUnknown,
    });
  }

  rows.sort(sortRows);
  return rows;
}

/** Counts `Fill` events in `events` where `wallet` was either the maker or the taker, keyed by market base58. Used by `MakerPanel` to show "fills" per strike. */
export function countFillsByMarket(events: readonly MeridianEvent[], wallet: PublicKey): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.name !== "Fill") {
      continue;
    }
    const { maker, taker, market } = event.data;
    if (!maker.equals(wallet) && !taker.equals(wallet)) {
      continue;
    }
    const key = market.toBase58();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
