/**
 * Nasdaq keyless quote source for the mock price provider's cross-check
 * (research.md R12, tasks.md T042). `api.nasdaq.com` requires a browser-like
 * `User-Agent` or it serves an empty/blocked response.
 */

import { DateTime } from "luxon";
import type { Ticker } from "@meridian/sdk";
import { SourceError, toMicroUsd, type PriceObservation } from "./types.js";

const NASDAQ_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const NASDAQ_TIME_FORMAT = "MMM d, yyyy h:mm a 'ET'";

const FETCH_TIMEOUT_MS = 5_000;

interface NasdaqPrimaryData {
  lastSalePrice?: string;
  lastTradeTimestamp?: string;
  isRealTime?: boolean;
}

interface NasdaqQuoteResponse {
  data?: {
    symbol?: string;
    primaryData?: NasdaqPrimaryData;
    marketStatus?: string;
  };
}

function normalizeMarketStatus(raw: string | undefined): "open" | "closed" | "unknown" {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  if (lower.includes("open")) return "open";
  if (lower.includes("closed")) return "closed";
  return "unknown";
}

function parseNasdaqTimestamp(raw: string, ticker: Ticker): number {
  // Strip a trailing "ET" variant difference defensively; the documented shape is
  // "Oct 6, 2026 2:54 PM ET".
  const dt = DateTime.fromFormat(raw, NASDAQ_TIME_FORMAT, {
    zone: "America/New_York",
    locale: "en-US",
  });
  if (!dt.isValid) {
    throw new SourceError(
      "nasdaq",
      `Nasdaq lastTradeTimestamp "${raw}" for ${ticker} could not be parsed: ${dt.invalidReason}`,
    );
  }
  return Math.floor(dt.toSeconds());
}

export async function fetchNasdaqQuote(
  ticker: Ticker,
  fetchImpl: typeof fetch = fetch,
): Promise<PriceObservation> {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/info?assetclass=stocks`;

  const controller = new AbortController();
  let timeoutId!: ReturnType<typeof setTimeout>;
  // Single timer covers both the fetch and the body read below (same pattern as
  // finnhub.ts): a deadline that trips mid-read still fails fast, not just a slow
  // connection.
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new SourceError("nasdaq", "timeout"));
    }, FETCH_TIMEOUT_MS);
  });

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        headers: {
          "User-Agent": NASDAQ_USER_AGENT,
          Accept: "application/json",
        },
        signal: controller.signal,
      }),
      deadline,
    ]);

    if (response.status !== 200) {
      throw new SourceError("nasdaq", `Nasdaq returned HTTP ${response.status}`, response.status);
    }

    const text = await Promise.race([response.text(), deadline]);
    const body = JSON.parse(text) as NasdaqQuoteResponse;
    const primaryData = body.data?.primaryData;

    if (!primaryData || !primaryData.lastSalePrice || !primaryData.lastTradeTimestamp) {
      throw new SourceError(
        "nasdaq",
        `Nasdaq response for ${ticker} is missing data.primaryData.lastSalePrice/lastTradeTimestamp`,
      );
    }

    if (body.data?.symbol !== ticker) {
      throw new SourceError(
        "nasdaq",
        `Nasdaq response symbol "${body.data?.symbol}" does not match requested ticker "${ticker}"`,
      );
    }

    const priceMicro = toMicroUsd(primaryData.lastSalePrice);
    const observedAt = parseNasdaqTimestamp(primaryData.lastTradeTimestamp, ticker);
    const marketStatus = normalizeMarketStatus(body.data?.marketStatus);

    return {
      ticker,
      source: "nasdaq",
      priceMicro,
      observedAt,
      marketStatus,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
