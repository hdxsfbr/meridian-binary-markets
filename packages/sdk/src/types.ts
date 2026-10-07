/**
 * Shared value types for the Meridian SDK: branded integer types for the
 * money path, the seven-ticker universe with their Pyth "Equity.US" feed
 * ids (research.md R4), and enums mirroring the on-chain program.
 *
 * No floats anywhere on the money path (FR-008): `MicroUsd`/`MicroUsdc` are
 * `bigint` brands, never `number`.
 */

declare const __brand: unique symbol;

/** A `bigint` branded so a plain bigint cannot be passed where a specific unit is expected. */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Micro-USD (6 decimals): strikes, settlement prices. */
export type MicroUsd = Brand<bigint, "MicroUsd">;

/** Micro-USDC (6 decimals): order book prices, vault/escrow amounts. */
export type MicroUsdc = Brand<bigint, "MicroUsdc">;

/** One USDC, in micro-units. */
export const ONE_USDC = 1_000_000n;

/** Maximum valid order-book price in micro-USDC per Yes token (data-model.md: `1..=999_999`). */
export const PRICE_MAX = 999_999n;

/** The seven tickers Meridian lists, in the canonical order used throughout the data model. */
export const Ticker = {
  AAPL: "AAPL",
  AMZN: "AMZN",
  GOOGL: "GOOGL",
  META: "META",
  MSFT: "MSFT",
  NVDA: "NVDA",
  TSLA: "TSLA",
} as const;

export type Ticker = (typeof Ticker)[keyof typeof Ticker];

/** The seven tickers, in the order they are listed in research.md R4 and data-model.md. */
export const TICKERS: readonly Ticker[] = [
  "AAPL",
  "AMZN",
  "GOOGL",
  "META",
  "MSFT",
  "NVDA",
  "TSLA",
] as const;

/**
 * Pyth `Equity.US.<SYM>/USD` regular-session feed ids (research.md R4), as
 * lowercase 64-character hex strings (32 bytes), without a `0x` prefix.
 */
export const FEED_IDS: Record<Ticker, string> = {
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  AMZN: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  GOOGL: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  META: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  MSFT: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  NVDA: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
};

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string "${hex}"`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The 32-byte feed id for `ticker`, decoded from `FEED_IDS`. */
export function feedIdBytes(ticker: Ticker): Uint8Array {
  const hex = FEED_IDS[ticker];
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) {
    throw new Error(`feedIdBytes: feed id for ${ticker} is ${bytes.length} bytes, expected 32`);
  }
  return bytes;
}

/** The 8-byte, zero-padded ASCII symbol bytes used in `Market`/`TickerInfo` and PDA seeds. */
export function tickerSymbolBytes(ticker: Ticker): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < ticker.length; i += 1) {
    out[i] = ticker.charCodeAt(i);
  }
  return out;
}

/**
 * Inverse of `tickerSymbolBytes`; requires exactly 8 bytes and matches by
 * byte-equal comparison against `tickerSymbolBytes(t)` for each ticker (no
 * ASCII decoding/masking), throwing on anything that isn't an exact match
 * for one of the seven tickers.
 */
export function tickerFromBytes(bytes: Uint8Array): Ticker {
  if (bytes.length !== 8) {
    throw new Error(`tickerFromBytes: expected exactly 8 bytes, got ${bytes.length}`);
  }
  for (const ticker of TICKERS) {
    const expected = tickerSymbolBytes(ticker);
    let matches = true;
    for (let i = 0; i < 8; i += 1) {
      if (bytes[i] !== expected[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return ticker;
    }
  }
  throw new Error(`tickerFromBytes: unknown ticker symbol bytes [${Array.from(bytes).join(",")}]`);
}

/** Mirrors `Config.oracle_provider` on chain. */
export enum OracleProvider {
  MockPyth = 0,
  PythReceiver = 1,
}

/** Mirrors `Market.state` on chain. */
export enum MarketState {
  Open = 0,
  Settled = 1,
}

/** Mirrors `Market.outcome` on chain. */
export enum Outcome {
  Unset = 0,
  Yes = 1,
  No = 2,
}

/** Mirrors the order book `Side` on chain. */
export enum Side {
  Bid = 0,
  Ask = 1,
}
