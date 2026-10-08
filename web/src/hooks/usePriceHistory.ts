"use client";

/**
 * Samples the shared price feed (`usePrices`, already polled by
 * `AppDataProvider` -- no new RPC/HTTP call here) into
 * `price-history.ts`'s per-ticker ring buffer, for the Trade page's
 * sparkline (REVAMP_PLAN.md Wave R3, decision 2).
 */

import { useEffect, useState } from "react";
import type { Ticker } from "@meridian/sdk";
import { getHistory, push, type PricePoint } from "@/lib/price-history";
import { usePrices } from "./usePrices";

/** The growing price-history buffer for `ticker`, updated whenever the shared price feed reports a new value. */
export function usePriceHistory(ticker: Ticker): readonly PricePoint[] {
  const prices = usePrices();
  const entry = prices[ticker];
  const [history, setHistory] = useState<readonly PricePoint[]>(() => getHistory(ticker));

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

  return history;
}
