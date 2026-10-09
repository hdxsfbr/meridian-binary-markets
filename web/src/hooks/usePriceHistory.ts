"use client";

/**
 * Samples the shared price feed (`usePrices`, already polled by
 * `AppDataProvider` -- no new RPC/HTTP call here) into
 * `price-history.ts`'s per-ticker ring buffer, for the Trade page's
 * sparkline (REVAMP_PLAN.md Wave R3, decision 2).
 *
 * Additionally seeds that buffer once per ticker per tab session (and at
 * most once per `SEED_TTL_MS`, so navigating back to a ticker shortly
 * after doesn't refetch) from `/api/price-history`'s server-side intraday
 * backfill, so a freshly opened tab shows the session's price curve
 * instead of starting empty. A failed seed fetch leaves the buffer exactly
 * as it was -- live samples keep accumulating as before.
 */

import { useEffect, useState } from "react";
import type { Ticker } from "@meridian/sdk";
import { getHistory, getSeedAt, mergeSeed, push, setSeedAt, type PricePoint } from "@/lib/price-history";
import { usePrices } from "./usePrices";

/** How often a ticker may be re-seeded from `/api/price-history` within one tab session; matches that route's own cache TTL. */
const SEED_TTL_MS = 60_000;

export type PriceHistoryResult = {
  points: readonly PricePoint[];
  /** True while the one-time seed fetch for `ticker` is in flight and the buffer is still empty-ish. */
  seeding: boolean;
};

/** The growing price-history buffer for `ticker`, updated whenever the shared price feed reports a new value, seeded once per session from the server backfill. */
export function usePriceHistory(ticker: Ticker): PriceHistoryResult {
  const prices = usePrices();
  const entry = prices[ticker];
  const [history, setHistory] = useState<readonly PricePoint[]>(() => getHistory(ticker));
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    setHistory(getHistory(ticker));
  }, [ticker]);

  useEffect(() => {
    if (entry === undefined) {
      return;
    }
    const ts = entry.publishTime || Math.floor(Date.now() / 1000);
    setHistory(push(ticker, entry.priceMicro, ts));
  }, [ticker, entry]);

  useEffect(() => {
    const seedAt = getSeedAt(ticker);
    if (seedAt !== undefined && Date.now() - seedAt < SEED_TTL_MS) {
      return;
    }
    let cancelled = false;
    setSeeding(true);
    async function seed() {
      try {
        const response = await fetch(`/api/price-history?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" });
        if (!response.ok || cancelled) {
          return;
        }
        const body = (await response.json()) as { ticker: string; points: { ts: number; priceMicro: string }[] };
        if (cancelled) {
          return;
        }
        setSeedAt(ticker, Date.now());
        setHistory(mergeSeed(ticker, body.points));
      } catch {
        // Seed fetch failed; behaviour is exactly today's (live samples only).
      } finally {
        if (!cancelled) {
          setSeeding(false);
        }
      }
    }
    void seed();
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  return { points: history, seeding };
}
