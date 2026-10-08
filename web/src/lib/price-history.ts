/**
 * Client-side ring buffer of observed prices per ticker, sampled from the
 * shared price feed (`usePrices`, via `useSparklineHistory`) for the Trade
 * page's sparkline (REVAMP_PLAN.md Wave R3, decision 2). This records
 * prices the app already fetched -- it never makes a new RPC/HTTP call of
 * its own.
 *
 * Pure except for the sessionStorage read/write used to persist a buffer
 * across a reload within the same tab session; both are wrapped so this
 * module is safe to import under Vitest (no `window`) and from the server
 * (SSR), where the in-memory buffer alone is used.
 */

export type PricePoint = { priceMicro: bigint; ts: number };

/** Kept points per ticker; old points drop off the front once this is exceeded. */
export const MAX_POINTS = 240;

const STORAGE_PREFIX = "meridian:price-history:";

type SerializedPoint = [string, number];

/** In-memory buffers, keyed by ticker; the source of truth within a page load. */
const buffers = new Map<string, PricePoint[]>();

function storageKey(ticker: string): string {
  return `${STORAGE_PREFIX}${ticker}`;
}

/**
 * The `Storage` object itself, or `undefined` if it can't be reached.
 * Reading `window.sessionStorage` (not just calling a method on it) can
 * throw a `SecurityError` in some browsers/privacy modes, so even that
 * property read has to live inside this try/catch.
 */
function trySessionStorage(): Storage | undefined {
  try {
    if (typeof window === "undefined") {
      return undefined;
    }
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function loadFromStorage(ticker: string): PricePoint[] {
  try {
    const storage = trySessionStorage();
    if (storage === undefined) {
      return [];
    }
    const raw = storage.getItem(storageKey(ticker));
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as SerializedPoint[];
    return parsed.map(([price, ts]) => ({ priceMicro: BigInt(price), ts }));
  } catch {
    return [];
  }
}

function persist(ticker: string, points: PricePoint[]): void {
  try {
    const storage = trySessionStorage();
    if (storage === undefined) {
      return;
    }
    const serialized: SerializedPoint[] = points.map((p) => [p.priceMicro.toString(), p.ts]);
    storage.setItem(storageKey(ticker), JSON.stringify(serialized));
  } catch {
    // sessionStorage full/unavailable (private mode, quota); the in-memory
    // buffer still works for the rest of this page's session.
  }
}

function bufferFor(ticker: string): PricePoint[] {
  const cached = buffers.get(ticker);
  if (cached !== undefined) {
    return cached;
  }
  const loaded = loadFromStorage(ticker);
  buffers.set(ticker, loaded);
  return loaded;
}

/**
 * Records a price sample for `ticker`. Dedupes an identical consecutive
 * sample at the *same* timestamp (a re-render with no new tick shouldn't
 * double up a point), but keeps a new point even when the price is
 * unchanged from the last one as long as its `ts` is newer -- a flat feed
 * still needs to produce a visible line across the time axis, not collapse
 * to a single point. Caps the buffer at `MAX_POINTS`, dropping the oldest
 * first. Returns the buffer after the push so callers can render
 * immediately without a second read.
 */
export function push(ticker: string, priceMicro: bigint, ts: number): readonly PricePoint[] {
  const existing = bufferFor(ticker);
  const last = existing[existing.length - 1];
  if (last !== undefined && last.priceMicro === priceMicro && last.ts === ts) {
    return existing;
  }
  const next = existing.concat([{ priceMicro, ts }]);
  while (next.length > MAX_POINTS) {
    next.shift();
  }
  buffers.set(ticker, next);
  persist(ticker, next);
  return next;
}

/** The current buffer for `ticker` (a snapshot copy), without recording a new sample. */
export function getHistory(ticker: string): readonly PricePoint[] {
  return bufferFor(ticker).slice();
}

/** Test-only: clears every in-memory and session-persisted buffer. */
export function _resetAllForTest(): void {
  buffers.clear();
  try {
    const storage = trySessionStorage();
    if (storage === undefined) {
      return;
    }
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(STORAGE_PREFIX)) {
        keys.push(key);
      }
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // ignore
  }
}
