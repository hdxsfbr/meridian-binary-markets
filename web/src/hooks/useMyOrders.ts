"use client";

/**
 * T082 / deferred Wave 5 review item: the wallet's resting orders across
 * EVERY market -- every ticker, every trading day, not just today's --
 * for the Portfolio market-maker view (`MyOrders`).
 *
 * Reuses `useMarkets.ts`'s `useAllMarkets` (already unfiltered by trading
 * day, built for `/admin`'s "unsettled markets" section) for the market
 * list, fetches each market's `Book` once, decodes it with `@meridian/sdk`'s
 * `decodeBook`, and keeps every book live via `onAccountChange` so a fill or
 * a cancel from elsewhere updates this table without a reload. `maker-view.ts`'s
 * `buildMyOrderRows` does the pure join (market + book -> this wallet's rows).
 *
 * Cancellation reuses `@/lib/tx`'s `cancelOrder`/`fetchUsdcMint`/`sendTx`/
 * `mapSendError` builders (the trade panel's and this wave's own contract;
 * nothing here duplicates them) -- one instruction per order, batched into
 * a single transaction for "cancel all on this market".
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSendTransaction } from "../lib/wallet-send";
import type { PublicKey } from "@solana/web3.js";
import { bookPda, decodeBook, type Book } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { buildMyOrderRows, type MyOrderRow } from "@/lib/maker-view";
import { cancelOrder, fetchUsdcMint, mapSendError, sendTx, type BuildCtx } from "@/lib/tx";
import { useToast } from "@/components/ui/Toast";
import { QUOTE_CANCELLED, quotesCancelledToastTitle } from "@/lib/trade-copy";
import { useAllMarkets, type MarketAccount } from "./useMarkets";
import { useProgram } from "./useProgram";

const REFRESH_INTERVAL_MS = 15_000;

function toMarketMeta(market: MarketAccount) {
  return {
    pubkey: market.pubkey,
    ticker: market.ticker,
    strike: market.strike,
    tradingDay: market.tradingDay,
    closeTs: market.closeTs,
    state: market.state,
  };
}

/** Most cancellations a single transaction packs for "cancel all on this market" (item 15); split into confirmed batches beyond this. */
const CANCEL_BATCH_SIZE = 6;

export type UseMyOrdersResult = {
  rows: MyOrderRow[];
  loading: boolean;
  /** A market's `Book` fetch failed at least once since the last successful load; `rows` may be stale for that market. */
  error: boolean;
  /** Decoded `Book` per market (base58), for callers that need to check the live book directly (e.g. a crossing check before queuing a quote). */
  books: ReadonlyMap<string, Book | null>;
  /** Base58 key of the order (or market, for "cancel all") currently being cancelled, or `null`. */
  cancelling: string | null;
  lastError: string | null;
  cancelOne: (row: MyOrderRow) => Promise<void>;
  cancelAllOnMarket: (marketKey: string) => Promise<void>;
  refresh: () => void;
};

/** The connected wallet's resting orders across every market, with cancel actions. */
export function useMyOrders(wallet: PublicKey | null): UseMyOrdersResult {
  const program = useProgram();
  const { connection } = useConnection();
  const sendTransaction = useSendTransaction();
  const { markets } = useAllMarkets();
  const { notify } = useToast();
  const [books, setBooks] = useState<Map<string, Book | null>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const marketKeys = useMemo(() => markets.map((m) => m.pubkey.toBase58()).join(","), [markets]);

  const load = useCallback(async () => {
    if (markets.length === 0) {
      setBooks(new Map());
      setLoading(false);
      return;
    }
    // Item 17: a per-market fetch failure (RPC hiccup, not "no Book
    // account yet") must not clobber that market's last good snapshot.
    // `failed` carries the distinction; `decoded` is only meaningful when
    // `failed` is false (including the legitimate `null` "no Book yet").
    // One `getMultipleAccountsInfo` per 100 markets rather than one
    // `getAccountInfo` per market: public devnet RPC caps a single method at
    // 40 calls per 10 s, which a per-market fan-out exceeded on load.
    let hadFailure = false;
    const entries: Array<{ key: string; decoded: Book | null; failed: boolean }> = [];
    for (let i = 0; i < markets.length; i += 100) {
      const slice = markets.slice(i, i + 100);
      const pdas = slice.map((market) => bookPda(PROGRAM_ID, market.pubkey)[0]);
      try {
        const infos = await connection.getMultipleAccountsInfo(pdas, "confirmed");
        infos.forEach((info, j) => {
          const key = slice[j].pubkey.toBase58();
          try {
            entries.push({ key, decoded: info === null ? null : decodeBook(Uint8Array.from(info.data)), failed: false });
          } catch {
            hadFailure = true;
            entries.push({ key, decoded: null, failed: true });
          }
        });
      } catch {
        hadFailure = true;
        for (const market of slice) entries.push({ key: market.pubkey.toBase58(), decoded: null, failed: true });
      }
    }
    setBooks((prev) => {
      const next = new Map(prev);
      for (const entry of entries) {
        if (!entry.failed) {
          next.set(entry.key, entry.decoded);
        }
        // else: keep whatever this market's map entry already held.
      }
      return next;
    });
    setError(hadFailure);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, marketKeys]);

  useEffect(() => {
    if (wallet === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);

    const subscriptionIds = markets.map((market) => {
      const [pda] = bookPda(PROGRAM_ID, market.pubkey);
      return connection.onAccountChange(
        pda,
        (accountInfo: { data: Buffer }) => {
          try {
            const decoded = decodeBook(Uint8Array.from(accountInfo.data));
            setBooks((prev) => {
              const next = new Map(prev);
              next.set(market.pubkey.toBase58(), decoded);
              return next;
            });
          } catch {
            // Transient/partial write mid-update; the next account-change event recovers.
          }
        },
        "confirmed",
      );
    });

    return () => {
      clearInterval(interval);
      for (const id of subscriptionIds) {
        void connection.removeAccountChangeListener(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, wallet, marketKeys, load]);

  const rows = useMemo(() => {
    if (wallet === null) {
      return [];
    }
    return buildMyOrderRows(markets.map(toMarketMeta), books, wallet);
  }, [markets, books, wallet]);

  const cancelOne = useCallback(
    async (row: MyOrderRow) => {
      if (wallet === null) {
        return;
      }
      setLastError(null);
      setCancelling(`order:${row.marketKey}:${row.orderId.toString()}`);
      try {
        const usdcMint = await fetchUsdcMint(program);
        const ctx: BuildCtx = { program, user: wallet, market: row.market, usdcMint };
        const ix = await cancelOrder(ctx, { orderId: row.orderId });
        await sendTx(connection, sendTransaction, [ix], wallet);
        await load();
        notify({ title: QUOTE_CANCELLED, tone: "success" });
      } catch (err) {
        setLastError(mapSendError(err));
      } finally {
        setCancelling(null);
      }
    },
    [wallet, program, connection, sendTransaction, load, notify],
  );

  const cancelAllOnMarket = useCallback(
    async (marketKey: string) => {
      if (wallet === null) {
        return;
      }
      const marketRows = rows.filter((r) => r.marketKey === marketKey);
      if (marketRows.length === 0) {
        return;
      }
      setLastError(null);
      setCancelling(`market:${marketKey}`);
      // Item 15: split into confirmed batches of at most CANCEL_BATCH_SIZE
      // cancellations, refreshing between batches so a mid-way failure
      // still reflects everything that already landed.
      let cancelledCount = 0;
      try {
        const usdcMint = await fetchUsdcMint(program);
        const ctx: BuildCtx = { program, user: wallet, market: marketRows[0].market, usdcMint };
        for (let i = 0; i < marketRows.length; i += CANCEL_BATCH_SIZE) {
          const batch = marketRows.slice(i, i + CANCEL_BATCH_SIZE);
          const ixs = await Promise.all(batch.map((r) => cancelOrder(ctx, { orderId: r.orderId })));
          await sendTx(connection, sendTransaction, ixs, wallet);
          cancelledCount += batch.length;
          await load();
        }
      } catch (err) {
        await load();
        setLastError(
          cancelledCount > 0
            ? `Cancelled ${cancelledCount} of ${marketRows.length} orders. ${mapSendError(err)}`
            : mapSendError(err),
        );
      } finally {
        setCancelling(null);
      }
      if (cancelledCount > 0) {
        notify({ title: quotesCancelledToastTitle(cancelledCount), tone: "success" });
      }
    },
    [wallet, rows, program, connection, sendTransaction, load, notify],
  );

  return {
    rows,
    loading,
    error,
    books,
    cancelling,
    lastError,
    cancelOne,
    cancelAllOnMarket,
    refresh: () => void load(),
  };
}
