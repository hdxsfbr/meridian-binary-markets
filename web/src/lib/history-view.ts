/**
 * Pure builder for the History page: turns the program's event stream into
 * one row per thing the wallet did (see `buildHistoryEntries`). React-free so
 * it can be unit-tested directly, like `positions-view.ts`.
 */

import type { PublicKey } from "@solana/web3.js";
import { ONE_USDC, Side, type MeridianEvent } from "@meridian/sdk";
import { formatStrike, formatTradingDay } from "./format";

export type HistoryKind = "mint" | "fill" | "order" | "cancel" | "settlement" | "redemption";

export type HistoryEntry = {
  signature: string;
  /** Unix seconds, if the transaction's block time was available. */
  ts?: number;
  kind: HistoryKind;
  label: string;
  /** "AAPL $330 · 2026-10-08", when the market is known from a `MarketCreated` event in the stream. */
  market?: string;
  /** Micro-USD/USDC, when the event carries a dollar amount. */
  amountMicro?: bigint;
  /**
   * Whole Yes contracts, when the event carries a Yes-token amount instead
   * of a dollar one (item 18: an ask cancellation refunds escrowed Yes, not
   * USDC). Mutually exclusive with `amountMicro`.
   */
  yesQty?: bigint;
  explorerUrl: string;
};

function explorerUrl(signature: string): string {
  const cluster = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
  if (cluster === "localnet") {
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
    return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

const BASE_UNITS_PER_CONTRACT = 1_000_000n;

/** Key for `OrderPlaced`/`OrderCancelled` correlation: same market, order id, and owner. */
function orderKey(market: PublicKey, orderId: bigint, owner: PublicKey): string {
  return `${market.toBase58()}:${orderId.toString()}:${owner.toBase58()}`;
}

function formatPriceDollars(priceMicro: bigint): string {
  const cents = Number(priceMicro / 10_000n);
  return `$${(cents / 100).toFixed(2)}`;
}

/** Everything one transaction did for `wallet`, before it is turned into rows. */
type TxForWallet = {
  signature: string;
  ts?: number;
  /** Markets this transaction touched for the wallet (base58). */
  markets: Set<string>;
  mintedQty: bigint;
  redeemedPairQty: bigint;
  /** Fills where the wallet took liquidity, by the wallet's side. */
  takerBoughtYes: { qty: bigint; usdc: bigint; noUsdc: bigint };
  takerSoldYes: { qty: bigint; usdc: bigint; noUsdc: bigint };
  /** Fills where the wallet's resting order was hit. */
  makerBoughtYes: { qty: bigint; usdc: bigint };
  makerSoldYes: { qty: bigint; usdc: bigint };
  placed?: { side: Side; price: bigint; qty: bigint };
  cancelled?: { side?: Side; refunded: bigint };
  winningPayout?: bigint;
  settledPrice?: bigint;
};

function emptyTx(signature: string, ts?: number): TxForWallet {
  return {
    signature,
    ts,
    markets: new Set<string>(),
    mintedQty: 0n,
    redeemedPairQty: 0n,
    takerBoughtYes: { qty: 0n, usdc: 0n, noUsdc: 0n },
    takerSoldYes: { qty: 0n, usdc: 0n, noUsdc: 0n },
    makerBoughtYes: { qty: 0n, usdc: 0n },
    makerSoldYes: { qty: 0n, usdc: 0n },
  };
}

/**
 * Builds the wallet's history entries from the full (not wallet-filtered)
 * event stream, one row per thing the user did rather than one per on-chain
 * event. The composite No paths (`buy_no_market` = mint + sell Yes + redeem
 * leftovers; `sell_no_market` = buy Yes + redeem pairs; `buy_no_limit` =
 * mint + rest an ask) are collapsed into "Bought No" / "Sold No" / a No-side
 * placed order, priced as the user saw them (No price = $1 − Yes price).
 * A resting order gets its own "Placed order" row for the part that rested.
 */
export function buildHistoryEntries(events: readonly MeridianEvent[], wallet: PublicKey): HistoryEntry[] {
  const touchedMarkets = new Set<string>();
  // Populated from `OrderPlaced` (oldest-first order, so a later `OrderCancelled`
  // for the same order id always finds its side here) -- item 18.
  const orderSides = new Map<string, Side>();
  const txs = new Map<string, TxForWallet>();
  const marketLabels = new Map<string, string>();
  const txFor = (event: MeridianEvent): TxForWallet => {
    let tx = txs.get(event.signature);
    if (tx === undefined) {
      tx = emptyTx(event.signature, event.ts);
      txs.set(event.signature, tx);
    }
    const data = event.data as { market?: PublicKey };
    if (data.market !== undefined) {
      tx.markets.add(data.market.toBase58());
    }
    return tx;
  };

  for (const event of events) {
    switch (event.name) {
      case "Minted": {
        if (!event.data.user.equals(wallet)) break;
        touchedMarkets.add(event.data.market.toBase58());
        txFor(event).mintedQty += event.data.qty;
        break;
      }
      case "PairRedeemed": {
        if (!event.data.user.equals(wallet)) break;
        touchedMarkets.add(event.data.market.toBase58());
        txFor(event).redeemedPairQty += event.data.qty;
        break;
      }
      case "WinningRedeemed": {
        if (!event.data.user.equals(wallet)) break;
        touchedMarkets.add(event.data.market.toBase58());
        const tx = txFor(event);
        tx.winningPayout = (tx.winningPayout ?? 0n) + event.data.payout;
        break;
      }
      case "OrderPlaced": {
        if (!event.data.owner.equals(wallet)) break;
        touchedMarkets.add(event.data.market.toBase58());
        orderSides.set(orderKey(event.data.market, event.data.orderId, event.data.owner), event.data.side);
        txFor(event).placed = { side: event.data.side, price: event.data.price, qty: event.data.qty };
        break;
      }
      case "OrderCancelled": {
        if (!event.data.owner.equals(wallet)) break;
        touchedMarkets.add(event.data.market.toBase58());
        txFor(event).cancelled = {
          side: orderSides.get(orderKey(event.data.market, event.data.orderId, event.data.owner)),
          refunded: event.data.remainingRefunded,
        };
        break;
      }
      case "Fill": {
        const isTaker = event.data.taker.equals(wallet);
        const isMaker = event.data.maker.equals(wallet);
        if (!isTaker && !isMaker) break;
        touchedMarkets.add(event.data.market.toBase58());
        if (isTaker && isMaker) break; // self-fill: nets to nothing worth showing
        const usdc = event.data.price * event.data.qty;
        const noUsdc = (ONE_USDC - event.data.price) * event.data.qty;
        const tx = txFor(event);
        if (isTaker) {
          const bucket = event.data.sideOfTaker === Side.Bid ? tx.takerBoughtYes : tx.takerSoldYes;
          bucket.qty += event.data.qty;
          bucket.usdc += usdc;
          bucket.noUsdc += noUsdc;
        } else {
          const bucket = event.data.sideOfTaker === Side.Bid ? tx.makerSoldYes : tx.makerBoughtYes;
          bucket.qty += event.data.qty;
          bucket.usdc += usdc;
        }
        break;
      }
      case "Settled": {
        if (!touchedMarkets.has(event.data.market.toBase58())) break;
        txFor(event).settledPrice = event.data.price;
        break;
      }
      case "MarketCreated": {
        const d = event.data;
        marketLabels.set(d.market.toBase58(), `${d.ticker} ${formatStrike(d.strike)} · ${formatTradingDay(d.tradingDay)}`);
        break;
      }
      case "Paused":
      case "Unpaused":
        break;
    }
  }

  const entries: HistoryEntry[] = [];
  function record(tx: TxForWallet, kind: HistoryKind, label: string, amount?: { amountMicro?: bigint; yesQty?: bigint }): void {
    const marketKey = tx.markets.size === 1 ? [...tx.markets][0] : undefined;
    entries.push({
      signature: tx.signature,
      ts: tx.ts,
      kind,
      label,
      market: marketKey !== undefined ? marketLabels.get(marketKey) : undefined,
      amountMicro: amount?.amountMicro,
      yesQty: amount?.yesQty,
      explorerUrl: explorerUrl(tx.signature),
    });
  }

  for (const tx of txs.values()) {
    const minted = tx.mintedQty > 0n;
    const redeemed = tx.redeemedPairQty > 0n;
    const soldYes = tx.takerSoldYes.qty > 0n;
    const boughtYes = tx.takerBoughtYes.qty > 0n;

    if (minted && soldYes) {
      // buy_no_market: the mint and any leftover redeem are plumbing.
      record(tx, "fill", "Bought No", { amountMicro: tx.takerSoldYes.noUsdc });
    } else if (redeemed && boughtYes && !minted) {
      // sell_no_market: the pair redeem is plumbing.
      record(tx, "fill", "Sold No", { amountMicro: tx.takerBoughtYes.noUsdc });
    } else if (minted && tx.placed !== undefined && tx.placed.side === Side.Ask && !soldYes) {
      // buy_no_limit: mint + rest an ask, i.e. a No bid at $1 − price.
      const noPrice = ONE_USDC - tx.placed.price;
      // The whole pair price leaves the wallet at mint time; the Yes side
      // comes back when the ask fills. Show what actually moved.
      record(tx, "order", `Placed order: Buy No at ${formatPriceDollars(noPrice)}`, {
        amountMicro: tx.mintedQty * ONE_USDC,
      });
    } else {
      if (minted) record(tx, "mint", "Minted pair", { amountMicro: tx.mintedQty * ONE_USDC });
      if (boughtYes) record(tx, "fill", "Bought Yes", { amountMicro: tx.takerBoughtYes.usdc });
      if (soldYes) record(tx, "fill", "Sold Yes", { amountMicro: tx.takerSoldYes.usdc });
      if (tx.placed !== undefined) {
        const filled = tx.placed.side === Side.Bid ? tx.takerBoughtYes.qty : tx.takerSoldYes.qty;
        const resting = tx.placed.qty - filled;
        if (resting > 0n) {
          if (tx.placed.side === Side.Bid) {
            record(tx, "order", `Placed order: Buy Yes at ${formatPriceDollars(tx.placed.price)}`, {
              amountMicro: tx.placed.price * resting,
            });
          } else {
            record(tx, "order", `Placed order: Sell Yes at ${formatPriceDollars(tx.placed.price)}`, { yesQty: resting });
          }
        }
      }
      if (redeemed) record(tx, "redemption", "Redeemed pair", { amountMicro: tx.redeemedPairQty * ONE_USDC });
    }

    if (tx.makerBoughtYes.qty > 0n) record(tx, "fill", "Bought Yes", { amountMicro: tx.makerBoughtYes.usdc });
    if (tx.makerSoldYes.qty > 0n) record(tx, "fill", "Sold Yes", { amountMicro: tx.makerSoldYes.usdc });
    if (tx.winningPayout !== undefined) record(tx, "redemption", "Redeemed winning", { amountMicro: tx.winningPayout });
    if (tx.cancelled !== undefined) {
      if (tx.cancelled.side === Side.Ask) {
        // Ask escrow is Yes tokens, not USDC (`cancel_order.rs`:
        // `pairs_to_usdc(remaining)` scales the Yes refund onto the same
        // numeric base as USDC, but it is still a Yes-token amount).
        record(tx, "cancel", "Cancelled order (Yes refunded)", { yesQty: tx.cancelled.refunded / BASE_UNITS_PER_CONTRACT });
      } else {
        record(tx, "cancel", "Cancelled order", { amountMicro: tx.cancelled.refunded });
      }
    }
    if (tx.settledPrice !== undefined) record(tx, "settlement", "Market settled", { amountMicro: tx.settledPrice });
  }

  entries.sort((a, b) => {
    const aTs = a.ts ?? 0;
    const bTs = b.ts ?? 0;
    return bTs - aTs; // newest first
  });
  return entries;
}

