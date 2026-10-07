"use client";

/**
 * T079: the wallet's chronological execution log (mints, fills, cancels,
 * settlements, redemptions) for the History page, with explorer links.
 * Built from the same cached event stream as `usePositions` (R11); see
 * `web/src/lib/events-cache.ts`.
 *
 * `Settled` events carry no wallet field (settlement affects every holder
 * at once), so they're only included for markets the wallet is otherwise
 * known to have touched (minted, traded, placed an order on, or redeemed
 * from) -- never for every settlement on the program.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { ONE_USDC, Side, type MeridianEvent } from "@meridian/sdk";
import { refreshEventCache } from "@/lib/events-cache";
import { PROGRAM_ID } from "@/lib/rpc";
import { useProgram } from "./useProgram";

const REFRESH_INTERVAL_MS = 30_000;

export type HistoryKind = "mint" | "fill" | "cancel" | "settlement" | "redemption";

export type HistoryEntry = {
  signature: string;
  /** Unix seconds, if the transaction's block time was available. */
  ts?: number;
  kind: HistoryKind;
  label: string;
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

/** Builds the wallet's history entries from the full (not wallet-filtered) event stream. */
export function buildHistoryEntries(events: readonly MeridianEvent[], wallet: PublicKey): HistoryEntry[] {
  const touchedMarkets = new Set<string>();
  const entries: HistoryEntry[] = [];
  // Populated from `OrderPlaced` (oldest-first order, so a later `OrderCancelled`
  // for the same order id always finds its side here) -- item 18.
  const orderSides = new Map<string, Side>();

  function record(
    event: MeridianEvent,
    kind: HistoryKind,
    label: string,
    amount?: { amountMicro?: bigint; yesQty?: bigint },
  ): void {
    entries.push({
      signature: event.signature,
      ts: event.ts,
      kind,
      label,
      amountMicro: amount?.amountMicro,
      yesQty: amount?.yesQty,
      explorerUrl: explorerUrl(event.signature),
    });
  }

  for (const event of events) {
    switch (event.name) {
      case "Minted": {
        if (!event.data.user.equals(wallet)) {
          break;
        }
        touchedMarkets.add(event.data.market.toBase58());
        record(event, "mint", "Minted pair", { amountMicro: event.data.qty * ONE_USDC });
        break;
      }
      case "PairRedeemed": {
        if (!event.data.user.equals(wallet)) {
          break;
        }
        touchedMarkets.add(event.data.market.toBase58());
        record(event, "redemption", "Redeemed pair", { amountMicro: event.data.qty * ONE_USDC });
        break;
      }
      case "WinningRedeemed": {
        if (!event.data.user.equals(wallet)) {
          break;
        }
        touchedMarkets.add(event.data.market.toBase58());
        record(event, "redemption", "Redeemed winning", { amountMicro: event.data.payout });
        break;
      }
      case "OrderPlaced": {
        if (!event.data.owner.equals(wallet)) {
          break;
        }
        touchedMarkets.add(event.data.market.toBase58());
        // Tracked so a later `OrderCancelled` for this same order id can
        // tell a bid (USDC refund) from an ask (Yes refund) apart -- item 18.
        orderSides.set(orderKey(event.data.market, event.data.orderId, event.data.owner), event.data.side);
        break;
      }
      case "OrderCancelled": {
        if (!event.data.owner.equals(wallet)) {
          break;
        }
        touchedMarkets.add(event.data.market.toBase58());
        const side = orderSides.get(orderKey(event.data.market, event.data.orderId, event.data.owner));
        if (side === Side.Ask) {
          // Ask escrow is Yes tokens, not USDC (`cancel_order.rs`:
          // `pairs_to_usdc(remaining)` scales the Yes refund onto the same
          // numeric base as USDC, but it is still a Yes-token amount).
          record(event, "cancel", "Cancelled order (Yes refunded)", {
            yesQty: event.data.remainingRefunded / BASE_UNITS_PER_CONTRACT,
          });
        } else {
          // Bid (or unknown -- the matching `OrderPlaced` fell outside the
          // cached window): escrow is USDC.
          record(event, "cancel", "Cancelled order", { amountMicro: event.data.remainingRefunded });
        }
        break;
      }
      case "Fill": {
        const isTaker = event.data.taker.equals(wallet);
        const isMaker = event.data.maker.equals(wallet);
        if (!isTaker && !isMaker) {
          break;
        }
        touchedMarkets.add(event.data.market.toBase58());
        if (isTaker && isMaker) {
          break; // self-fill: nets to nothing worth showing twice
        }
        const walletAction = isTaker
          ? event.data.sideOfTaker
          : event.data.sideOfTaker === Side.Bid
            ? Side.Ask
            : Side.Bid;
        const label = walletAction === Side.Bid ? "Bought Yes" : "Sold Yes";
        record(event, "fill", label, { amountMicro: event.data.price * event.data.qty });
        break;
      }
      case "Settled": {
        if (!touchedMarkets.has(event.data.market.toBase58())) {
          break;
        }
        record(event, "settlement", "Market settled", { amountMicro: event.data.price });
        break;
      }
      case "MarketCreated":
      case "Paused":
      case "Unpaused":
        break;
    }
  }

  entries.sort((a, b) => {
    const aTs = a.ts ?? 0;
    const bTs = b.ts ?? 0;
    return bTs - aTs; // newest first
  });
  return entries;
}

export type UseHistoryResult = {
  entries: HistoryEntry[];
  loading: boolean;
  error: boolean;
};

/** The wallet's chronological execution log, newest first. */
export function useHistory(wallet: PublicKey | null): UseHistoryResult {
  const program = useProgram();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    if (wallet === null) {
      setEntries([]);
      setLoading(false);
      return;
    }
    try {
      const events = await refreshEventCache(program.provider.connection, PROGRAM_ID);
      if (generationRef.current !== generation) {
        return;
      }
      setEntries(buildHistoryEntries(events, wallet));
      setError(false);
    } catch {
      if (generationRef.current === generation) {
        setError(true);
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false);
      }
    }
  }, [program, wallet]);

  useEffect(() => {
    setLoading(true);
    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  return { entries, loading, error };
}
