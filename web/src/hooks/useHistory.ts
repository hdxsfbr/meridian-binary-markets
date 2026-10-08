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
import { refreshEventCache } from "@/lib/events-cache";
import { buildHistoryEntries, type HistoryEntry } from "@/lib/history-view";

export type { HistoryEntry, HistoryKind } from "@/lib/history-view";
import { PROGRAM_ID } from "@/lib/rpc";
import { useProgram } from "./useProgram";

const REFRESH_INTERVAL_MS = 30_000;

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
