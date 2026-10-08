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

/**
 * Well-known ticker symbols with Pyth feeds in `FEED_IDS`. The set a
 * deployment actually lists is the on-chain `Config.tickers` (enabled
 * entries), initialised from `TICKERS` and changeable with
 * `init-config --update --tickers ...`; nothing else in the stack assumes a
 * fixed universe, so adding a symbol is a config change once its feed is
 * entitled.
 */
export const Ticker = {
  AAPL: "AAPL",
  AMZN: "AMZN",
  GOOGL: "GOOGL",
  META: "META",
  MSFT: "MSFT",
  NVDA: "NVDA",
  TSLA: "TSLA",
  QQQ: "QQQ",
  VOO: "VOO",
  SPY: "SPY",
} as const;

/** A ticker symbol: up to 8 ASCII characters, as stored in `Market.ticker` / `TickerInfo.symbol`. */
export type Ticker = string;

/** The symbols in `Ticker`, for callers that want the full known catalogue. */
export type KnownTicker = (typeof Ticker)[keyof typeof Ticker];

/**
 * Default listed set: the US equity feeds the project's Pyth key is entitled
 * to (TSLA plus the QQQ and VOO index ETFs, 2026-10-08). The PRD's other
 * names (AAPL, AMZN, GOOGL, META, MSFT, NVDA) stay in `FEED_IDS` and can be
 * enabled by config the day their feeds are granted.
 */
export const TICKERS: readonly Ticker[] = ["TSLA", "QQQ", "VOO"] as const;

/**
 * Pyth `Equity.US.<SYM>/USD` regular-session feed ids (research.md R4), as
 * lowercase 64-character hex strings (32 bytes), without a `0x` prefix.
 */
export const FEED_IDS: Record<string, string> = {
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  AMZN: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  GOOGL: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  META: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  MSFT: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  NVDA: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  QQQ: "9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d",
  VOO: "236b30dd09a9c00dfeec156c7b1efd646c0f01825a1758e3e4a0679e3bdff179",
  SPY: "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
};

/** Every symbol with a known feed id. */
export const KNOWN_TICKERS: readonly Ticker[] = Object.keys(FEED_IDS);

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

/** The 32-byte feed id for `ticker`, decoded from `FEED_IDS`; throws for a symbol without a known feed. */
export function feedIdBytes(ticker: Ticker): Uint8Array {
  const hex = FEED_IDS[ticker];
  if (hex === undefined) {
    throw new Error(`feedIdBytes: no known Pyth feed for ${ticker}; add it to FEED_IDS`);
  }
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) {
    throw new Error(`feedIdBytes: feed id for ${ticker} is ${bytes.length} bytes, expected 32`);
  }
  return bytes;
}

const TICKER_PATTERN = /^[A-Z0-9.]{1,8}$/;

/** The 8-byte, zero-padded ASCII symbol bytes used in `Market`/`TickerInfo` and PDA seeds. */
export function tickerSymbolBytes(ticker: Ticker): Uint8Array {
  if (!TICKER_PATTERN.test(ticker)) {
    throw new Error(`tickerSymbolBytes: "${ticker}" is not a 1-8 character uppercase symbol`);
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < ticker.length; i += 1) {
    out[i] = ticker.charCodeAt(i);
  }
  return out;
}

/**
 * Inverse of `tickerSymbolBytes`: exactly 8 bytes, ASCII up to the first
 * zero byte, which must form a valid symbol. Not checked against any fixed
 * list: the listed set lives in the on-chain `Config`.
 */
export function tickerFromBytes(bytes: Uint8Array): Ticker {
  if (bytes.length !== 8) {
    throw new Error(`tickerFromBytes: expected exactly 8 bytes, got ${bytes.length}`);
  }
  let end = 0;
  while (end < 8 && bytes[end] !== 0) end += 1;
  for (let i = end; i < 8; i += 1) {
    if (bytes[i] !== 0) {
      throw new Error(`tickerFromBytes: non-zero padding in symbol bytes [${Array.from(bytes).join(",")}]`);
    }
  }
  const symbol = String.fromCharCode(...bytes.subarray(0, end));
  if (!TICKER_PATTERN.test(symbol)) {
    throw new Error(`tickerFromBytes: invalid ticker symbol bytes [${Array.from(bytes).join(",")}]`);
  }
  return symbol;
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
