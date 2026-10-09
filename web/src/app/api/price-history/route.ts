/**
 * `GET /api/price-history?ticker=AAPL`: intraday session backfill for the
 * Trade page sparkline (`usePriceHistory`), so a freshly opened tab shows
 * the day's price curve instead of starting empty. Backfills from 09:30 ET
 * of the current trading day (or the most recent one, if before today's
 * open or on a weekend -- `currentSessionWindow`) through now, at 1-minute
 * resolution, from the Pyth Pro History API (`real_time/history`, the
 * TradingView UDF shape) -- a different Pyth endpoint than `/api/prices`'s
 * Hermes latest-price proxy, but the same key (`@/lib/pyth-key`), read the
 * same way and never exposed to the browser.
 *
 * Caches the parsed series per ticker for `CACHE_TTL_MS` and coalesces
 * concurrent requests for the same ticker onto one upstream call. Never
 * returns a 5xx: an upstream failure falls back to the last cached series
 * (or an empty one) with `stale: true`, so a transient History API outage
 * degrades the sparkline's backfill rather than breaking the Trade page.
 */

import { KNOWN_TICKERS } from "@meridian/sdk";
import { currentSessionWindow } from "@/lib/markets";
import { parseUdfHistory, type RemotePoint, type UdfHistoryResponse } from "@/lib/price-history-remote";
import { pythApiKey } from "@/lib/pyth-key";

export const dynamic = "force-dynamic";

// The Pyth Pro History API base URL (a different host/path than Hermes's
// `PYTH_HERMES_URL`, which only serves latest prices). Not made
// configurable via env, unlike `PYTH_HERMES_URL`: there is exactly one
// provider and endpoint for this data today, and the existing Pyth key is
// reused as-is (`@/lib/pyth-key`) rather than adding a new variable.
const HISTORY_URL = "https://pyth.dourolabs.app/v1";
const CACHE_TTL_MS = 60_000;
const MAX_WINDOW_SECONDS = 24 * 60 * 60;
const KNOWN_TICKER_SET = new Set(KNOWN_TICKERS);

type CacheEntry = { at: number; points: RemotePoint[] };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<RemotePoint[]>>();

export type PriceHistoryResponse = { ticker: string; points: RemotePoint[]; stale?: true };

/** `Equity.US.<TICKER>/USD`, the Pyth Pro symbol for every ticker in `KNOWN_TICKERS` (verified 1:1 against `/v1/symbols`). */
function pythSymbol(ticker: string): string {
  return `Equity.US.${ticker}/USD`;
}

async function fetchFromUpstream(ticker: string, from: number, to: number): Promise<RemotePoint[]> {
  const key = pythApiKey();
  if (key === undefined) {
    throw new Error("price-history: no Pyth API key configured");
  }
  const url = `${HISTORY_URL}/real_time/history?symbol=${encodeURIComponent(pythSymbol(ticker))}&resolution=1&from=${from}&to=${to}`;
  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!upstream.ok) {
    throw new Error(`price-history: upstream returned ${upstream.status}`);
  }
  const body = (await upstream.json()) as UdfHistoryResponse;
  return parseUdfHistory(body);
}

/** Fetches (or joins an in-flight fetch for) `ticker`'s series, with per-ticker request coalescing. */
async function load(ticker: string, from: number, to: number): Promise<RemotePoint[]> {
  const existing = inFlight.get(ticker);
  if (existing !== undefined) {
    return existing;
  }
  const promise = fetchFromUpstream(ticker, from, to).finally(() => {
    inFlight.delete(ticker);
  });
  inFlight.set(ticker, promise);
  return promise;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ticker = (url.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (ticker === "" || !KNOWN_TICKER_SET.has(ticker)) {
    // An unrecognised ticker is not an error -- just nothing to backfill.
    return Response.json({ ticker, points: [] } satisfies PriceHistoryResponse);
  }

  const { from: windowFrom, to } = currentSessionWindow();
  const from = Math.max(windowFrom, to - MAX_WINDOW_SECONDS);

  const cached = cache.get(ticker);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return Response.json({ ticker, points: cached.points } satisfies PriceHistoryResponse);
  }

  try {
    const points = await load(ticker, from, to);
    cache.set(ticker, { at: Date.now(), points });
    return Response.json({ ticker, points } satisfies PriceHistoryResponse);
  } catch {
    if (cached !== undefined) {
      return Response.json({ ticker, points: cached.points, stale: true } satisfies PriceHistoryResponse);
    }
    return Response.json({ ticker, points: [], stale: true } satisfies PriceHistoryResponse);
  }
}
