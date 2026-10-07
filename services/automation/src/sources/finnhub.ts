/**
 * Finnhub `/quote` source for the mock price provider (research.md R12,
 * tasks.md T042). Free-tier keys are capped at 60 calls/minute; this module
 * enforces that budget itself rather than relying on the caller to pace
 * requests, so a bug elsewhere in the service fails closed with a typed
 * error instead of tripping Finnhub's own rate limiter.
 */

import type { Ticker } from "@meridian/sdk";
import { SourceError, toMicroUsd, type PriceObservation } from "./types.js";

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1/quote";
const RATE_BUDGET_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

// Extracts a JSON number field's raw decimal text, e.g. `"c":333.41` -> "333.41".
// Used instead of `JSON.parse`/`response.json()` so the price never passes through
// a float: `JSON.parse` would silently round/represent `c` as an IEEE-754 double
// before we ever see it, which is exactly the drift `toMicroUsd` exists to avoid.
function extractRawNumberField(text: string, field: string): string {
  const match = new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(text);
  if (!match) {
    throw new SourceError("finnhub", `Finnhub response is missing field "${field}"`);
  }
  return match[1];
}

export interface FinnhubQuote {
  current: PriceObservation;
  previousClose: bigint;
  tradeTime: number;
}

// Module-level call timestamps for the simple sliding-window rate budget.
// Deliberately module state (not per-instance): Finnhub's limit is per API
// key, and the service holds one key.
const callTimestamps: number[] = [];

function pruneAndCheckBudget(): void {
  const now = Date.now();
  while (callTimestamps.length > 0 && now - callTimestamps[0] >= RATE_WINDOW_MS) {
    callTimestamps.shift();
  }
  if (callTimestamps.length >= RATE_BUDGET_PER_MINUTE) {
    throw new SourceError("finnhub", "rate budget exhausted");
  }
  callTimestamps.push(now);
}

/** Test-only escape hatch so budget tests don't depend on wall-clock timing. */
export function __resetFinnhubRateBudget(): void {
  callTimestamps.length = 0;
}

export async function fetchFinnhubQuote(
  ticker: Ticker,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FinnhubQuote> {
  pruneAndCheckBudget();

  const url = `${FINNHUB_BASE_URL}?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  let timeoutId!: ReturnType<typeof setTimeout>;
  // Single timer covers both the fetch and the body read below, so a deadline
  // that trips mid-read (slow body, not just a slow connection) still fails fast.
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new SourceError("finnhub", "timeout"));
    }, FETCH_TIMEOUT_MS);
  });

  try {
    const response = await Promise.race([fetchImpl(url, { signal: controller.signal }), deadline]);

    if (response.status !== 200) {
      throw new SourceError("finnhub", `Finnhub returned HTTP ${response.status}`, response.status);
    }

    const text = await Promise.race([response.text(), deadline]);

    // Extract c/pc/t as raw decimal text, never through `response.json()`/`JSON.parse`,
    // which would represent the price as an IEEE-754 double before `toMicroUsd` ever
    // sees it (T042: no floats anywhere on the money path).
    const rawC = extractRawNumberField(text, "c");
    const rawPc = extractRawNumberField(text, "pc");
    const rawT = extractRawNumberField(text, "t");

    if (rawC === "0") {
      throw new SourceError("finnhub", `Finnhub quote for ${ticker} is zero (no data)`);
    }

    const priceMicro = toMicroUsd(rawC);
    const previousClose = toMicroUsd(rawPc);
    const tradeTime = Number(rawT);

    return {
      current: {
        ticker,
        source: "finnhub",
        priceMicro,
        observedAt: tradeTime,
        marketStatus: "unknown",
      },
      previousClose,
      tradeTime,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
