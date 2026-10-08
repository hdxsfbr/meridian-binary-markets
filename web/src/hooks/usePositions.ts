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

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { bookPda, buildPositions, decodeBook, summarize, tickerFromBytes, type Position, type PositionSummary } from "@meridian/sdk";
import { TOKEN_PROGRAM_ID } from "@/lib/ata";
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
import { AppDataContext } from "./app-data-context";

const BASE_UNITS_PER_CONTRACT = 1_000_000n;

/**
 * Every market's on-chain inventory for `wallet` in three RPC calls total,
 * not three per market: one `getTokenAccountsByOwner` for every Yes/No
 * balance the wallet holds, and `getMultipleAccountsInfo` (100 per call) for
 * the markets' Books, from which the wallet's own resting asks are summed.
 * Public devnet RPC allows 40 calls per method per 10 s; the previous
 * per-market fan-out exceeded that on the first page load.
 *
 * Never throws: a missing ATA is a zero balance, and a missing or corrupt
 * Book is zero resting Yes.
 */
async function allMarketInventories(
  connection: Connection,
  markets: readonly MarketLike[],
  wallet: PublicKey,
): Promise<Map<string, { available: AvailableBalance; restingYes: bigint }>> {
  const balancesByMint = new Map<string, bigint>();
  try {
    const owned = await connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }, "confirmed");
    for (const { account } of owned.value) {
      const data = Uint8Array.from(account.data);
      if (data.length < 72) continue;
      const mint = new PublicKey(data.subarray(0, 32)).toBase58();
      const amount = new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true);
      balancesByMint.set(mint, (balancesByMint.get(mint) ?? 0n) + amount);
    }
  } catch {
    // RPC flake: treat as no balances this round, same tolerance as before.
  }

  const bookAddresses = markets.map((market) => bookPda(PROGRAM_ID, market.pubkey)[0]);
  const restingByMarket = new Map<string, bigint>();
  for (let i = 0; i < bookAddresses.length; i += 100) {
    const slice = bookAddresses.slice(i, i + 100);
    let infos: Array<{ data: Buffer } | null> = [];
    try {
      infos = await connection.getMultipleAccountsInfo(slice, "confirmed");
    } catch {
      infos = slice.map(() => null);
    }
    infos.forEach((info, j) => {
      const market = markets[i + j];
      if (info === null) return;
      try {
        const book = decodeBook(Uint8Array.from(info.data));
        const resting = book.asks
          .filter((order) => order.owner.equals(wallet))
          .reduce((sum, order) => sum + order.remaining, 0n);
        restingByMarket.set(market.pubkey.toBase58(), resting);
      } catch {
        // Not a well-formed Book; treat as no resting Yes.
      }
    });
  }

  const out = new Map<string, { available: AvailableBalance; restingYes: bigint }>();
  for (const market of markets) {
    const key = market.pubkey.toBase58();
    out.set(key, {
      available: {
        yes: (balancesByMint.get(market.yesMint.toBase58()) ?? 0n) / BASE_UNITS_PER_CONTRACT,
        no: (balancesByMint.get(market.noMint.toBase58()) ?? 0n) / BASE_UNITS_PER_CONTRACT,
      },
      restingYes: restingByMarket.get(key) ?? 0n,
    });
  }
  return out;
}

const REFRESH_INTERVAL_MS = 30_000;

type BnLike = { toString(): string };
type EnumValue = Record<string, unknown>;
type RawMarket = {
  ticker: number[];
  strike: BnLike;
  tradingDay: number;
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
    tradingDay: raw.tradingDay,
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
  /** False until the wallet's trade history has synced at least once; cost basis and P&L are placeholders before that. */
  historyLoaded: boolean;
  /** Positions are showing but the latest trade-history sync failed; cost basis and P&L may be stale. */
  historyError: boolean;
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

/**
 * The wallet's Portfolio view: positions, summary, and the market data
 * they're joined against. Reads the shared snapshot from `AppDataProvider`
 * when one is mounted above the caller (the normal case: it wraps the whole
 * app in `layout.tsx`, and polls the connected wallet's positions once for
 * everyone -- the Portfolio page and the nav's "redeem all" pill both read
 * the same snapshot instead of each starting its own poll). Falls back to
 * polling itself (via `usePositionsPolling`) only when no provider is
 * present, e.g. in an isolated test.
 */
export function usePositions(wallet: PublicKey | null): UsePositionsResult {
  const ctx = useContext(AppDataContext);
  const polled = usePositionsPolling(wallet, ctx !== undefined);
  return ctx !== undefined ? ctx.positions : polled;
}

/**
 * The actual polling implementation: fetches positions on a 30s interval,
 * paging the event cache in the background. Exactly one instance of this
 * should run per wallet -- `AppDataProvider` is the only caller that should
 * invoke it directly; every other caller should use `usePositions` above.
 *
 * `skip` short-circuits the effect (no fetch, no interval) once a
 * provider's own snapshot has taken over for `usePositions`' fallback
 * instance, the same convention as `useConfigPolling`.
 */
export function usePositionsPolling(wallet: PublicKey | null, skip = false): UsePositionsResult {
  const program = useProgram();
  const [rows, setRows] = useState<PositionRowData[]>([]);
  const [summary, setSummary] = useState<PositionSummary>(EMPTY_SUMMARY);
  const [fillsCountByMarket, setFillsCountByMarket] = useState<Map<string, number>>(new Map());
  const [markets, setMarkets] = useState<MarketLike[]>([]);
  const [historyComplete, setHistoryComplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  /** True when positions rendered but the trade-history sync behind them failed; cleared on the next successful sync. */
  const [historyError, setHistoryError] = useState(false);
  /** False until the event history has been synced at least once for the current wallet. */
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    // No wallet: nothing to show and nothing to fetch. Reset to empty and
    // return before any RPC call or event-cache work starts -- a
    // disconnected wallet should never trigger a `market.all()` fetch, an
    // inventory read, or `refreshEventCacheDetailed`.
    if (wallet === null) {
      setRows([]);
      setSummary(EMPTY_SUMMARY);
      setFillsCountByMarket(new Map());
      setMarkets([]);
      setHistoryComplete(false);
      setHistoryLoaded(false);
      setHistoryError(false);
      setError(false);
      setLoading(false);
      return;
    }
    let holdingsRendered = false;
    try {
      const connection = program.provider.connection;
      // Start the (slow, paced) event sync but do not wait for it: on-chain
      // balances render first, so the Positions list appears within a couple
      // of RPC round-trips; cost basis and realized P&L fill in when the
      // history sync finishes.
      const eventsPromise = refreshEventCacheDetailed(connection, PROGRAM_ID);
      const rawMarkets = (await accountClient(program, "market").all()) as Array<{ publicKey: PublicKey; account: RawMarket }>;
      if (generationRef.current !== generation) {
        return; // a newer load superseded this one
      }

      const decodedMarkets = rawMarkets.map(({ publicKey, account }) => decodeMarket(publicKey, account));
      setMarkets(decodedMarkets);

      // Available (wallet ATAs) and escrowed (resting asks) inventory,
      // read straight from the chain (item 5) -- the event-derived
      // `positions` below supplies cost basis/realized P&L only.
      const inventories = await allMarketInventories(connection, decodedMarkets, wallet);
      if (generationRef.current !== generation) {
        return;
      }
      const available = new Map(decodedMarkets.map((m) => [m.pubkey.toBase58(), inventories.get(m.pubkey.toBase58())!.available]));
      const restingYes = new Map(decodedMarkets.map((m) => [m.pubkey.toBase58(), inventories.get(m.pubkey.toBase58())!.restingYes]));

      // First render: holdings only, cost basis pending.
      setRows(buildPositionRows(new Map(), decodedMarkets, available, restingYes));
      setLoading(false);
      setError(false);
      holdingsRendered = true;

      const eventsResult = await eventsPromise;
      if (generationRef.current !== generation) {
        return;
      }
      setHistoryComplete(eventsResult.complete);
      const positions: Map<string, Position> = buildPositions(eventsResult.events, wallet);
      setRows(buildPositionRows(positions, decodedMarkets, available, restingYes));
      setSummary(summarize(positions));
      setFillsCountByMarket(countFillsByMarket(eventsResult.events, wallet));
      setHistoryLoaded(true);
      setHistoryError(false);
      setError(false);
    } catch (err) {
      console.error("[meridian] positions load failed", err);
      if (generationRef.current === generation) {
        if (holdingsRendered) {
          setHistoryError(true);
        } else {
          setError(true);
        }
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false);
      }
    }
  }, [program, wallet]);

  useEffect(() => {
    if (skip) {
      return;
    }
    // No wallet: reset to empty and skip starting the poll entirely --
    // no RPC call, no event-cache work, no 30s interval for a wallet that
    // isn't connected.
    if (wallet === null) {
      generationRef.current += 1;
      setRows([]);
      setSummary(EMPTY_SUMMARY);
      setFillsCountByMarket(new Map());
      setMarkets([]);
      setHistoryComplete(false);
      setHistoryLoaded(false);
      setHistoryError(false);
      setError(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load, skip, wallet]);

  return { rows, summary, loading, error, fillsCountByMarket, markets, historyComplete, historyLoaded, historyError, refresh: () => void load() };
}
