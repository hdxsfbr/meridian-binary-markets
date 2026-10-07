/**
 * Shared types for the mock-provider price sources (Finnhub, Nasdaq;
 * research.md R12). Both sources normalise onto `PriceObservation` so the
 * caller (the `MockPythProvider`, Wave 4) can cross-check them without
 * knowing which transport produced either reading.
 *
 * No floats on the money path (FR-008): prices move as decimal strings
 * until `toMicroUsd` turns them into exact micro-USD bigints.
 */

import type { Ticker } from "@meridian/sdk";

export type SourceName = "finnhub" | "nasdaq";

export interface PriceObservation {
  ticker: Ticker;
  source: SourceName;
  /** Micro-USD (6 decimals), exact — never derived through a float. */
  priceMicro: bigint;
  /** Unix seconds. */
  observedAt: number;
  marketStatus?: "open" | "closed" | "unknown";
}

/** Typed error for both sources, carrying the HTTP status when there is one. */
export class SourceError extends Error {
  readonly source: SourceName;
  readonly status?: number;

  constructor(source: SourceName, message: string, status?: number) {
    super(message);
    this.name = "SourceError";
    this.source = source;
    this.status = status;
  }
}

const MICROS_PER_USD = 1_000_000n;

// "333.41", "$333.41", "1,234.5", "-12.3" (rejected: no negative price), etc.
const DECIMAL_PATTERN = /^\$?(\d{1,3}(?:,\d{3})*|\d+)(\.(\d+))?$/;

/**
 * Parses a decimal price string (optionally `$`-prefixed, optionally
 * comma-grouped) into exact micro-USD. Works entirely on strings/bigints so
 * there is no float rounding anywhere in the path.
 *
 * Throws on malformed input: empty, negative, non-numeric, more than 6
 * fractional digits of precision loss (truncation beyond 6 decimals is
 * rejected rather than silently rounded), or anything that doesn't match a
 * plain decimal shape.
 */
export function toMicroUsd(decimalString: string): bigint {
  const trimmed = decimalString.trim();
  const match = DECIMAL_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`toMicroUsd: malformed price "${decimalString}"`);
  }

  const integerPart = match[1].replace(/,/g, "");
  const fractionPart = match[3] ?? "";

  if (fractionPart.length > 6) {
    throw new Error(
      `toMicroUsd: price "${decimalString}" has more than 6 fractional digits, cannot convert without loss`,
    );
  }

  const paddedFraction = fractionPart.padEnd(6, "0");
  const micro = BigInt(integerPart) * MICROS_PER_USD + BigInt(paddedFraction || "0");
  return micro;
}
