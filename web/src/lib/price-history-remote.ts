/**
 * Pure helpers for `/api/price-history`: turning a Pyth Pro History API
 * (TradingView UDF shape) response into the micro-USD points the route
 * returns, and merging point series by timestamp. Kept pure and separate
 * from the route itself (which owns the cache, coalescing and fetch) so
 * this is unit-testable with no network or timers.
 */

/** `GET /v1/real_time/history` response shape (TradingView UDF). */
export type UdfHistoryResponse = {
  s: "ok" | "no_data" | "error";
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
  errmsg?: string;
};

export type RemotePoint = { ts: number; priceMicro: string };

/**
 * Tickers whose Pyth Pro History API symbol is `Crypto.<T>/USD` rather than
 * the `Equity.US.<T>/USD` regular-session symbol (DECISIONS.md §30: BTC's
 * 24/7 feed is what makes a weekend settlement possible). Extend this set
 * alongside `@meridian/sdk`'s `FEED_IDS` if another crypto ticker is added.
 */
const CRYPTO_TICKERS = new Set(["BTC"]);

/**
 * The Pyth Pro History API symbol for `ticker`: `Crypto.<T>/USD` for a
 * crypto ticker (`CRYPTO_TICKERS`), else the equities' `Equity.US.<T>/USD`
 * regular-session symbol (verified 1:1 against `/v1/symbols`).
 */
export function pythHistorySymbol(ticker: string): string {
  return CRYPTO_TICKERS.has(ticker) ? `Crypto.${ticker}/USD` : `Equity.US.${ticker}/USD`;
}

/**
 * A dollar price (e.g. UDF's `c` close, a JSON number) as a micro-USD
 * integer string. Rounds to the nearest micro-dollar rather than
 * truncating, so repeated round-trips don't drift.
 */
export function dollarsToMicroString(dollars: number): string {
  return BigInt(Math.round(dollars * 1_000_000)).toString();
}

/**
 * The UDF response's `t`/`c` arrays merged into one `RemotePoint` per bar,
 * using the close as the price. Returns `[]` for `s: "no_data"`/`"error"`,
 * a missing/malformed `t` or `c`, or any `t[i]`/`c[i]` the JSON decoded as
 * something other than a finite number -- never throws on an upstream
 * shape surprise.
 */
export function parseUdfHistory(body: UdfHistoryResponse): RemotePoint[] {
  if (body.s !== "ok" || !Array.isArray(body.t) || !Array.isArray(body.c)) {
    return [];
  }
  const t = body.t;
  const c = body.c;
  const n = Math.min(t.length, c.length);
  const points: RemotePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const ts = t[i];
    const close = c[i];
    if (typeof ts !== "number" || !Number.isFinite(ts) || typeof close !== "number" || !Number.isFinite(close)) {
      continue;
    }
    points.push({ ts, priceMicro: dollarsToMicroString(close) });
  }
  return points;
}

/**
 * Merges two already-reasonable point series into one, deduped by
 * timestamp (a later series wins a tie, since it's typically the fresher
 * live sample overriding a backfilled bar at the same second) and sorted
 * ascending by `ts`. Used both server-side (merging a retry's points into
 * a stale cache is not needed today, but kept pure here for callers that
 * do) and by the client hook merging the remote seed with the live ring
 * buffer.
 */
export function mergeByTimestamp<T extends { ts: number }>(base: readonly T[], overlay: readonly T[]): T[] {
  const byTs = new Map<number, T>();
  for (const point of base) {
    byTs.set(point.ts, point);
  }
  for (const point of overlay) {
    byTs.set(point.ts, point);
  }
  return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
}
