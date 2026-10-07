/**
 * Pure view-model layer for the market-maker view's resting-orders table
 * (T082 / deferred Wave 5 review item): decodes which of a wallet's
 * resting orders live on which `Book`, across every trading day (not just
 * today's), and derives the figures `MyOrders`/`MakerPanel` render --
 * grouping, sorting, and the escrow each resting order has locked.
 *
 * No React, no RPC here -- `useMyOrders.ts` is the hook that wires this to
 * the network; this module is unit-tested on its own in
 * `maker-view.test.ts`, the same split as `positions-view.ts`.
 *
 * Units: `price` is micro-USDC per whole contract (matches `Order.price`
 * from `@meridian/sdk`'s `book.ts`); `remaining` is whole contracts (matches
 * `Order.remaining`, the same convention `OrderList`/`usePosition` use, not
 * base units). A bid escrows USDC (`price * remaining`); an ask escrows Yes
 * tokens (`remaining` Yes, not a dollar figure -- there is no USDC amount to
 * show for a resting ask, only how many Yes it holds back from the wallet).
 */

import type { PublicKey } from "@solana/web3.js";
import type { Book } from "@meridian/sdk";

/** The subset of a decoded `Market` a resting-order row needs to display, independent of which hook (`useMarkets`/`useAllMarkets`) produced it. */
export type MarketMeta = {
  pubkey: PublicKey;
  ticker: string;
  strike: bigint;
  /** `YYYYMMDD`, matching `Market.trading_day`. */
  tradingDay: number;
  closeTs: bigint;
  state: "open" | "settled";
};

export type OrderSide = "bid" | "ask";

/** One resting order the wallet owns, joined with the market it rests on. */
export type MyOrderRow = {
  market: PublicKey;
  marketKey: string;
  ticker: string;
  strike: bigint;
  tradingDay: number;
  closeTs: bigint;
  state: "open" | "settled";
  side: OrderSide;
  orderId: bigint;
  price: bigint;
  remaining: bigint;
  /** Micro-USDC escrowed by this order; set only for `side === "bid"`. */
  lockedUsdcMicro?: bigint;
  /** Whole Yes contracts escrowed by this order; set only for `side === "ask"`. */
  lockedYesQty?: bigint;
};

/** A resting Yes bid locks `price * remaining` micro-USDC until it fills or is cancelled. */
export function lockedForBid(price: bigint, remaining: bigint): bigint {
  return price * remaining;
}

/** A resting Yes ask locks `remaining` Yes tokens (not a dollar amount) until it fills or is cancelled. */
export function lockedForAsk(remaining: bigint): bigint {
  return remaining;
}

/** `yes - no`: a market-maker's net directional exposure at one strike, independent of any pair held (matched Yes+No, shown separately). */
export function exposureForStrike(yes: bigint, no: bigint): bigint {
  return yes - no;
}

/**
 * Builds one row per resting order the wallet owns across `markets`' books.
 * `books` is keyed by market pubkey (base58); a market absent from `books`
 * (not yet fetched, or no `Book` created) contributes no rows.
 */
export function buildMyOrderRows(
  markets: readonly MarketMeta[],
  books: ReadonlyMap<string, Book | null>,
  wallet: PublicKey,
): MyOrderRow[] {
  const rows: MyOrderRow[] = [];
  for (const market of markets) {
    const key = market.pubkey.toBase58();
    const book = books.get(key);
    if (!book) {
      continue;
    }
    for (const order of book.bids) {
      if (!order.owner.equals(wallet)) {
        continue;
      }
      rows.push({
        market: market.pubkey,
        marketKey: key,
        ticker: market.ticker,
        strike: market.strike,
        tradingDay: market.tradingDay,
        closeTs: market.closeTs,
        state: market.state,
        side: "bid",
        orderId: order.id,
        price: order.price,
        remaining: order.remaining,
        lockedUsdcMicro: lockedForBid(order.price, order.remaining),
      });
    }
    for (const order of book.asks) {
      if (!order.owner.equals(wallet)) {
        continue;
      }
      rows.push({
        market: market.pubkey,
        marketKey: key,
        ticker: market.ticker,
        strike: market.strike,
        tradingDay: market.tradingDay,
        closeTs: market.closeTs,
        state: market.state,
        side: "ask",
        orderId: order.id,
        price: order.price,
        remaining: order.remaining,
        lockedYesQty: lockedForAsk(order.remaining),
      });
    }
  }
  return sortMyOrderRows(rows);
}

/** Most recent trading day first, then ticker, then strike, then bids before asks, then price. */
export function sortMyOrderRows(rows: readonly MyOrderRow[]): MyOrderRow[] {
  return [...rows].sort((a, b) => {
    if (a.tradingDay !== b.tradingDay) {
      return b.tradingDay - a.tradingDay;
    }
    if (a.ticker !== b.ticker) {
      return a.ticker < b.ticker ? -1 : 1;
    }
    if (a.strike !== b.strike) {
      return a.strike < b.strike ? -1 : 1;
    }
    if (a.side !== b.side) {
      return a.side === "bid" ? -1 : 1;
    }
    if (a.price !== b.price) {
      return a.price < b.price ? -1 : 1;
    }
    return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
  });
}

export type OrderGroup = { tradingDay: number; ticker: string; rows: MyOrderRow[] };

/** Groups (already-sorted) rows by trading day then ticker, preserving `sortMyOrderRows`'s order within each group. */
export function groupMyOrderRows(rows: readonly MyOrderRow[]): OrderGroup[] {
  const sorted = sortMyOrderRows(rows);
  const groups: OrderGroup[] = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.tradingDay === row.tradingDay && last.ticker === row.ticker) {
      last.rows.push(row);
    } else {
      groups.push({ tradingDay: row.tradingDay, ticker: row.ticker, rows: [row] });
    }
  }
  return groups;
}

/** Resting totals for one market: live quantity and escrow on each side. */
export type RestingTotals = {
  bidQty: bigint;
  askQty: bigint;
  lockedUsdcMicro: bigint;
  lockedYesQty: bigint;
};

const ZERO_TOTALS: RestingTotals = { bidQty: 0n, askQty: 0n, lockedUsdcMicro: 0n, lockedYesQty: 0n };

/** Resting totals (quantity and escrow per side), keyed by market pubkey (base58). */
export function restingTotalsByMarket(rows: readonly MyOrderRow[]): Map<string, RestingTotals> {
  const totals = new Map<string, RestingTotals>();
  for (const row of rows) {
    const existing = totals.get(row.marketKey) ?? { ...ZERO_TOTALS };
    if (row.side === "bid") {
      existing.bidQty += row.remaining;
      existing.lockedUsdcMicro += row.lockedUsdcMicro ?? 0n;
    } else {
      existing.askQty += row.remaining;
      existing.lockedYesQty += row.lockedYesQty ?? 0n;
    }
    totals.set(row.marketKey, existing);
  }
  return totals;
}
