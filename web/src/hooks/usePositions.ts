"use client";

/**
 * T077: a wallet's reconstructed Portfolio view. Pages the Meridian event
 * stream (`web/src/lib/events-cache.ts`, backed by `@meridian/sdk`'s
 * `events.ts`/`pnl.ts`, research.md R11), folds it into per-market
 * `Position`s for the connected wallet, and joins those with every `Market`
 * account (not just today's -- `useMarkets` is day-scoped, so this fetches
 * `program.account.market.all()` directly) via `positions-view.ts`'s pure
 * `buildPositionRows`.
 *
 * Refreshes on mount and every 30s; the underlying cache (`events-cache.ts`)
 * only re-fetches signatures newer than what is already cached, so repeat
 * polls are cheap once the wallet's history has been paged once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection, PublicKey } from "@solana/web3.js";
import { bookPda, buildPositions, decodeBook, summarize, tickerFromBytes, type Position, type PositionSummary } from "@meridian/sdk";
import { associatedTokenAddress } from "@/lib/ata";
import { refreshEventCacheDetailed } from "@/lib/events-cache";
import {
  buildPositionRows,
  countFillsByMarket,
  type AvailableBalance,
  type MarketLike,
  type PositionRowData,
} from "@/lib/positions-view";
import { PROGRAM_ID } from "@/lib/rpc";
import { accountClient, useProgram } from "./useProgram";

const BASE_UNITS_PER_CONTRACT = 1_000_000n;

/** A wallet's available (ATA) balance for one mint, whole contracts; 0 on any failure (missing ATA or RPC flake) -- Portfolio tolerates this the same way `usePosition` tolerates a missing ATA. */
async function availableBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const result = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(result.value.amount) / BASE_UNITS_PER_CONTRACT;
  } catch {
    return 0n;
  }
}

/**
 * One market's on-chain inventory for `wallet` (item 5): available Yes/No
 * (the wallet's ATAs) and escrowed Yes (the wallet's own resting asks on
 * the market's `Book`). Never throws: a missing ATA or missing/corrupt
 * Book both resolve to zero rather than failing the whole refresh.
 */
async function marketInventory(
  connection: Connection,
  market: MarketLike,
  wallet: PublicKey,
): Promise<{ available: AvailableBalance; restingYes: bigint }> {
  const yesAta = associatedTokenAddress(wallet, market.yesMint);
  const noAta = associatedTokenAddress(wallet, market.noMint);
  const [bookAddress] = bookPda(PROGRAM_ID, market.pubkey);

  const [yes, no, bookInfo] = await Promise.all([
    availableBalance(connection, yesAta),
    availableBalance(connection, noAta),
    connection.getAccountInfo(bookAddress, "confirmed").catch(() => null),
  ]);

  let restingYes = 0n;
  if (bookInfo !== null) {
    try {
      const book = decodeBook(Uint8Array.from(bookInfo.data));
      restingYes = book.asks
        .filter((order) => order.owner.equals(wallet))
        .reduce((sum, order) => sum + order.remaining, 0n);
    } catch {
      // Not a well-formed Book (shouldn't happen for a real Book account); treat as no resting Yes.
    }
  }

  return { available: { yes, no }, restingYes };
}

const REFRESH_INTERVAL_MS = 30_000;

type BnLike = { toString(): string };
type EnumValue = Record<string, unknown>;
type RawMarket = {
  ticker: number[];
  strike: BnLike;
  closeTs: BnLike;
  state: EnumValue;
  outcome: EnumValue;
  settlementPrice: BnLike;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
};

function enumKey(value: EnumValue): string {
  return Object.keys(value)[0] ?? "";
}

function toBigInt(value: BnLike): bigint {
  return BigInt(value.toString());
}

function decodeMarket(pubkey: PublicKey, raw: RawMarket): MarketLike {
  return {
    pubkey,
    ticker: tickerFromBytes(Uint8Array.from(raw.ticker)),
    strike: toBigInt(raw.strike),
    closeTs: toBigInt(raw.closeTs),
    state: enumKey(raw.state) as MarketLike["state"],
    outcome: enumKey(raw.outcome) as MarketLike["outcome"],
    settlementPrice: toBigInt(raw.settlementPrice),
    yesMint: raw.yesMint,
    noMint: raw.noMint,
    vault: raw.vault,
  };
}

export type UsePositionsResult = {
  rows: PositionRowData[];
  summary: PositionSummary;
  loading: boolean;
  error: boolean;
  /** Fill counts per market (base58), for the market-maker exposure view. */
  fillsCountByMarket: Map<string, number>;
  /** Every decoded `Market` account, across all trading days -- for the mint-pair market picker. */
  markets: MarketLike[];
  /** False while the event cache's backfill has not yet reached the beginning of program history (item 13): cost basis/P&L may be understated until then. */
  historyComplete: boolean;
  /** Forces an immediate refresh, bypassing the 30s interval. */
  refresh: () => void;
};

const EMPTY_SUMMARY: PositionSummary = {
  yes: 0n,
  no: 0n,
  mintedPairs: 0n,
  costBasisMicro: 0n,
  realizedPnlMicro: 0n,
};

/** The wallet's Portfolio view: positions, summary, and the market data they're joined against. */
export function usePositions(wallet: PublicKey | null): UsePositionsResult {
  const program = useProgram();
  const [rows, setRows] = useState<PositionRowData[]>([]);
  const [summary, setSummary] = useState<PositionSummary>(EMPTY_SUMMARY);
  const [fillsCountByMarket, setFillsCountByMarket] = useState<Map<string, number>>(new Map());
  const [markets, setMarkets] = useState<MarketLike[]>([]);
  const [historyComplete, setHistoryComplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const connection = program.provider.connection;
      const [eventsResult, rawMarkets] = await Promise.all([
        refreshEventCacheDetailed(connection, PROGRAM_ID),
        accountClient(program, "market").all() as Promise<Array<{ publicKey: PublicKey; account: RawMarket }>>,
      ]);
      if (generationRef.current !== generation) {
        return; // a newer load superseded this one
      }

      const decodedMarkets = rawMarkets.map(({ publicKey, account }) => decodeMarket(publicKey, account));
      setMarkets(decodedMarkets);
      setHistoryComplete(eventsResult.complete);

      if (wallet === null) {
        setRows([]);
        setSummary(EMPTY_SUMMARY);
        setFillsCountByMarket(new Map());
      } else {
        // Available (wallet ATAs) and escrowed (resting asks) inventory,
        // read straight from the chain (item 5) -- the event-derived
        // `positions` below supplies cost basis/realized P&L only.
        const inventories = await Promise.all(
          decodedMarkets.map((market) => marketInventory(connection, market, wallet)),
        );
        if (generationRef.current !== generation) {
          return;
        }
        const available = new Map(decodedMarkets.map((m, i) => [m.pubkey.toBase58(), inventories[i].available]));
        const restingYes = new Map(decodedMarkets.map((m, i) => [m.pubkey.toBase58(), inventories[i].restingYes]));

        const positions: Map<string, Position> = buildPositions(eventsResult.events, wallet);
        setRows(buildPositionRows(positions, decodedMarkets, available, restingYes));
        setSummary(summarize(positions));
        setFillsCountByMarket(countFillsByMarket(eventsResult.events, wallet));
      }
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

  return { rows, summary, loading, error, fillsCountByMarket, markets, historyComplete, refresh: () => void load() };
}
