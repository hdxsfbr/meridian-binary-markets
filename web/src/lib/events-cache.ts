"use client";

/**
 * Browser-local cache of decoded Meridian program events, shared by
 * `usePositions` and `useHistory` (T077/T079; research.md R11). Avoids
 * re-fetching and re-decoding every transaction on every 30s poll.
 *
 * Caching is per-program, not per-wallet: `MeridianEvent`s for every wallet
 * share one on-chain event stream, and `buildPositions`/the history view
 * each do their own wallet filtering over the full decoded list (R11: a
 * maker's `Fill` never appears in the maker's own transaction history, so
 * only a program-wide, not wallet-scoped, signature list sees every event
 * that mentions a given wallet).
 *
 * ## Shape (v4)
 *
 * - The cache key is namespaced by cluster + genesis hash + program id
 *   (item 12): a devnet validator reset reuses the same cluster name and
 *   program id but mints a new genesis hash, so a stale cache from the
 *   previous validator incarnation is never mistaken for the current one.
 *   As a second line of defense, every refresh checks that the oldest
 *   cached signature is still findable on chain; if not (same genesis hash,
 *   but the validator was reset without a fresh key, e.g. local dev),
 *   the cache is wiped and rebuilt from scratch.
 * - Every cached entry carries a `seq`, used as a `(slot, seq)` ascending
 *   sort tiebreaker for transactions sharing a slot (the worker's
 *   `events-index.ts` derives it the same way, see "Remote-first sync"
 *   below) -- without it, entries sharing a slot would sort by discovery
 *   order instead of true on-chain order.
 * - There is no cap on cached signature count or on backfill pages (item
 *   13): a `backfillCursor` (the next `getSignaturesForAddress` `before` to
 *   fetch) is persisted across refreshes, and `complete` is only set once a
 *   backfill page comes back short of a full page (the true beginning of
 *   the program's history). Until `complete`, `refreshEventCache`'s result
 *   is a partial history; callers label P&L accordingly.
 * - A transaction that fails to fetch/decode is kept in `retrySignatures`
 *   and retried on every subsequent refresh (item 14); the signature-paging
 *   cursors advance regardless (there is nothing to re-page -- the
 *   signature itself is already known), so a transient fetch failure can
 *   never wedge backfill progress, but the event data for that signature is
 *   also never silently dropped.
 * - The envelope's shape is validated before use (item 15): a malformed or
 *   foreign payload (wrong version, non-array fields) is discarded, not
 *   fed to the fold.
 *
 * ## Remote-first sync (worker-served event index)
 *
 * When `NEXT_PUBLIC_EVENTS_INDEX_URL` is set (the automation worker's base
 * URL), a refresh first fetches that worker's pre-built, program-wide event
 * index instead of paging the chain itself: the worker has already done the
 * slow part (paging every signature since genesis and decoding every
 * transaction) continuously server-side, so the browser can just download
 * the result. The payload is validated (`programId`/`genesisHash` must
 * match this browser's own connection, via the same namespacing as the
 * cache key below) before any of its entries are merged in -- a mismatch
 * (wrong deployment, stale worker) means the fetch is treated exactly like
 * a failure and ignored.
 *
 * Only a remote payload that itself reports `complete: true` is ever
 * merged in; an incomplete, unreachable, or mismatched response is ignored
 * entirely (no partial merge) and the chain-based sync below runs exactly
 * as if the remote fetch had never happened. This also decides which
 * request is made: `GET /events?after=<newest cached signature>` only when
 * this browser's *own* cache already reports `complete: true` (so a short
 * delta response's `complete: true` -- meaning "the worker's full index is
 * complete", not "this delta is the full history" -- can't be
 * misinterpreted as covering gaps this cache doesn't have); otherwise (the
 * local cache is incomplete, or empty) the request is `GET /events` with no
 * `after`, so a `complete: true` response is guaranteed to be the worker's
 * *entire* history and safe to adopt wholesale. The local cache is only
 * ever marked `complete` here as a direct result of importing one of those
 * full, complete remote payloads (or, as before, by the chain backfill
 * itself reaching genesis).
 *
 * The existing chain-based forward sync below still runs afterward,
 * unconditionally: it only ever pages from the (now possibly
 * remote-advanced) newest known signature to the chain head, which is
 * normally empty or one page, so it is cheap even when the remote fetch
 * just did most of the work -- and it is what catches a transaction the
 * worker hasn't indexed yet within its own 30s poll. The backfill loop
 * (towards genesis, with its own cursor) is completely unaffected by the
 * remote fetch one way or the other, so an ignored/partial remote payload
 * can never bypass or corrupt it.
 *
 * Merging uses the same total order the worker uses (`(slot, seq)`
 * ascending, see `CachedEntry.seq` above) and dedupes by signature, so a
 * remote entry and a locally-fetched entry for the same signature can
 * never both end up in the cache, and multiple transactions sharing a slot
 * keep true on-chain order regardless of which source(s) discovered them.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import {
  deserializeEventIndexPayload,
  parseEventsFromTransaction,
  type EventIndexEntry,
  type MeridianEvent,
} from "@meridian/sdk";

const CACHE_KEY_PREFIX = "meridian:events:v4:";
const CACHE_VERSION = 4;
const SIGNATURES_PAGE_SIZE = 1000;
/** Per-refresh budget on backfill pages; progress persists via `backfillCursor`, so this never prevents eventually reaching `complete`. */
const MAX_BACKFILL_PAGES_PER_REFRESH = 10;

type CachedEntry = {
  signature: string;
  slot: number;
  /** `(slot, seq)` ascending is this cache's total order; see module doc "Shape (v4)". */
  seq: number;
  ts?: number;
  events: MeridianEvent[];
};

type CacheEnvelope = {
  version: typeof CACHE_VERSION;
  entries: CachedEntry[];
  /** Next `before` cursor for backfill (older-than); `undefined` if backfill hasn't started or is complete. */
  backfillCursor?: string;
  /** True once a backfill page has come back short, i.e. genesis has been reached. */
  complete: boolean;
  /** Signatures seen (via `getSignaturesForAddress`) but not yet successfully fetched/decoded. */
  retrySignatures: string[];
};

function emptyEnvelope(): CacheEnvelope {
  return { version: CACHE_VERSION, entries: [], backfillCursor: undefined, complete: false, retrySignatures: [] };
}

function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Generic bigint/PublicKey-safe JSON (de)serialization. `MeridianEvent.data`
// shapes vary by event name (events.ts), so this walks any plain
// object/array structure rather than hand-writing one (de)serializer per
// event.
// ---------------------------------------------------------------------------

type Tagged = { __bigint: string } | { __pubkey: string };

/**
 * Duck-typed PublicKey check. `instanceof PublicKey` is not enough: the
 * production bundle can carry two copies of `@solana/web3.js` (the SDK's and
 * the wallet adapter's), and a key built by one copy fails `instanceof`
 * against the other. A key that slipped through as a plain object came back
 * from the cache without `.equals`, crashing the P&L replay on every refresh
 * after the first.
 */
function isPublicKeyLike(value: unknown): value is { toBase58: () => string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function" &&
    typeof (value as { toBytes?: unknown }).toBytes === "function"
  );
}

function serializeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __bigint: value.toString() } satisfies Tagged;
  }
  if (isPublicKeyLike(value)) {
    return { __pubkey: value.toBase58() } satisfies Tagged;
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

function deserializeValue(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    if ("__bigint" in (value as Record<string, unknown>)) {
      return BigInt((value as { __bigint: string }).__bigint);
    }
    if ("__pubkey" in (value as Record<string, unknown>)) {
      return new PublicKey((value as { __pubkey: string }).__pubkey);
    }
    if (Array.isArray(value)) {
      return value.map(deserializeValue);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deserializeValue(v);
    }
    return out;
  }
  return value;
}

/** Validates the envelope's shape (item 15): right version, arrays where arrays are expected. Anything else is treated as absent. */
function isValidEnvelopeShape(value: unknown): value is CacheEnvelope {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.version !== CACHE_VERSION) {
    return false;
  }
  if (!Array.isArray(v.entries)) {
    return false;
  }
  if (!Array.isArray(v.retrySignatures)) {
    return false;
  }
  if (typeof v.complete !== "boolean") {
    return false;
  }
  if (v.backfillCursor !== undefined && typeof v.backfillCursor !== "string") {
    return false;
  }
  for (const entry of v.entries) {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.signature !== "string" ||
      typeof e.slot !== "number" ||
      typeof e.seq !== "number" ||
      !Array.isArray(e.events)
    ) {
      return false;
    }
  }
  for (const sig of v.retrySignatures) {
    if (typeof sig !== "string") {
      return false;
    }
  }
  return true;
}

function loadCache(key: string): CacheEnvelope {
  if (!hasLocalStorage()) {
    return emptyEnvelope();
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return emptyEnvelope();
    }
    const parsed = JSON.parse(raw) as unknown;
    const restored = deserializeValue(parsed);
    if (!isValidEnvelopeShape(restored)) {
      // Malformed/foreign/old-version payload: discard rather than crash (item 15).
      return emptyEnvelope();
    }
    return restored;
  } catch {
    // Corrupt JSON: start fresh rather than throwing.
    return emptyEnvelope();
  }
}

function saveCache(key: string, envelope: CacheEnvelope): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(serializeValue(envelope)));
  } catch {
    // Storage quota exceeded or disabled: the in-memory result for this
    // refresh is still returned to the caller; only persistence is skipped.
  }
}

// ---------------------------------------------------------------------------
// Cache key namespacing (item 12).
// ---------------------------------------------------------------------------

const genesisHashCache = new WeakMap<Connection, Promise<string>>();

/** Fetches (and memoizes per-`Connection`) the cluster's genesis hash. */
function genesisHashFor(connection: Connection): Promise<string> {
  let cached = genesisHashCache.get(connection);
  if (cached === undefined) {
    cached = connection.getGenesisHash();
    genesisHashCache.set(connection, cached);
  }
  return cached;
}

async function cacheKeyFor(connection: Connection, programId: PublicKey): Promise<string> {
  const cluster = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
  let genesisHash: string;
  try {
    genesisHash = await genesisHashFor(connection);
  } catch {
    // Genesis hash lookup failed; fall back to a cluster-only namespace
    // rather than failing the whole refresh (a subsequent refresh can still
    // succeed and migrate to the fully-namespaced key).
    genesisHash = "unknown";
  }
  return `${CACHE_KEY_PREFIX}${cluster}:${genesisHash}:${programId.toBase58()}`;
}

/**
 * True if `signature` is still findable on chain (via `getSignatureStatuses`).
 * A validator reset that reuses the same genesis hash (local/dev validators
 * restarted with `--reset` sometimes do) otherwise leaves a cache whose
 * oldest signature silently no longer exists; this is the second line of
 * defense beyond the genesis-hash namespacing (item 12).
 */
async function oldestSignatureStillOnChain(connection: Connection, signature: string): Promise<boolean> {
  try {
    const result = await connection.getSignatureStatuses([signature]);
    return result.value[0] !== null;
  } catch {
    // Could not check (RPC flake): assume still valid rather than wiping a
    // possibly-good cache over a transient error.
    return true;
  }
}

/** Result of `refreshEventCache`, with completeness so callers can label partial P&L (item 13). */
export type RefreshResult = {
  events: MeridianEvent[];
  /** True once backfill has reached the beginning of the program's history. */
  complete: boolean;
};

/** `(slot, seq)` ascending -- the same total order the worker uses (see module doc "Shape (v4)"). */
function sortedEntries(entriesBySignature: Map<string, CachedEntry>): CachedEntry[] {
  return [...entriesBySignature.values()].sort((a, b) => a.slot - b.slot || a.seq - b.seq);
}

/**
 * Fetches the worker's event index (`GET /events`, or `GET
 * /events?after=<after>` when `after` is given), validates it against this
 * browser's own `programId`/genesis hash, and returns its entries plus
 * completeness -- or `null` on any failure (unset URL, network error, bad
 * JSON, wrong shape, or a `programId`/genesis hash mismatch), so the caller
 * can fall back to the chain replay exactly as if this function didn't
 * exist.
 */
export async function fetchRemoteEvents(
  connection: Connection,
  programId: PublicKey,
  after: string | undefined,
): Promise<{ entries: EventIndexEntry[]; complete: boolean } | null> {
  // Read lazily (not hoisted to a module-level constant): `NEXT_PUBLIC_*` is normally inlined by
  // Next.js' build-time static replacement anyway, but reading it per-call also lets tests set
  // `process.env` directly without needing to reload the module.
  const eventsIndexUrl = process.env.NEXT_PUBLIC_EVENTS_INDEX_URL;
  if (eventsIndexUrl === undefined || eventsIndexUrl === "") {
    return null;
  }
  try {
    const base = eventsIndexUrl.replace(/\/$/, "");
    const url = after === undefined ? `${base}/events` : `${base}/events?after=${encodeURIComponent(after)}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const raw = await response.json();
    const payload = deserializeEventIndexPayload(raw);

    if (payload.programId !== programId.toBase58()) {
      return null;
    }
    const genesisHash = await genesisHashFor(connection);
    if (payload.genesisHash !== genesisHash) {
      return null;
    }

    return { entries: payload.entries, complete: payload.complete };
  } catch {
    // Network error, non-JSON body, or a shape `deserializeEventIndexPayload`
    // rejects (wrong version, corrupt entry, etc.): treated the same as the
    // URL being unset.
    return null;
  }
}

type FetchedEntry = { signature: string; slot: number; ts?: number; events: MeridianEvent[] };

/** Fetches and decodes one transaction's events; `null` on failure (kept for retry, item 14). `seq` is assigned by the caller (see "Shape (v4)"). */
async function fetchEntry(connection: Connection, programId: PublicKey, signature: string): Promise<FetchedEntry | null> {
  try {
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (tx === null) {
      return null;
    }
    const events = parseEventsFromTransaction(tx, programId);
    return { signature, slot: tx.slot, ts: tx.blockTime ?? undefined, events };
  } catch {
    return null;
  }
}

/**
 * Refreshes (and returns) the full, chronologically-ordered (oldest-first,
 * by slot) decoded event list for `programId`. See module doc for the
 * caching strategy (namespacing, unbounded backfill via a persisted cursor,
 * retry-on-failure, shape validation).
 */
export async function refreshEventCache(connection: Connection, programId: PublicKey): Promise<MeridianEvent[]> {
  const result = await refreshEventCacheDetailed(connection, programId);
  return result.events;
}

/** Same as `refreshEventCache`, but also reports whether backfill is complete (item 13). */
/**
 * Minimum spacing between transaction fetches. Public devnet RPC allows 40
 * calls per method per 10 s; a tight loop over `getParsedTransaction` ran
 * at several times that and was rate-limited into failing every fetch.
 * Overridable per deployment (`NEXT_PUBLIC_RPC_TX_FETCH_SPACING_MS`) so a
 * private endpoint with a higher limit syncs history faster.
 */
const TRANSACTION_FETCH_SPACING_MS = Number(process.env.NEXT_PUBLIC_RPC_TX_FETCH_SPACING_MS ?? "600");

/** In-flight refresh per cache key: several hooks refresh at once on page load and must share one sync. */
const inFlight = new Map<string, Promise<RefreshResult>>();

export async function refreshEventCacheDetailed(connection: Connection, programId: PublicKey): Promise<RefreshResult> {
  const key = await cacheKeyFor(connection, programId);
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const run = refreshEventCacheUncached(connection, programId, key).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

async function refreshEventCacheUncached(connection: Connection, programId: PublicKey, cacheKey: string): Promise<RefreshResult> {
  const key = cacheKey;
  let envelope = loadCache(key);

  const entriesBySignature = new Map<string, CachedEntry>(envelope.entries.map((e) => [e.signature, e]));

  // Item 12 (second line of defense): if the oldest cached signature is no
  // longer on chain, this is a reset validator wearing the same genesis
  // hash; wipe and start over.
  const oldestEntry = sortedEntries(entriesBySignature)[0];
  if (oldestEntry !== undefined) {
    const stillThere = await oldestSignatureStillOnChain(connection, oldestEntry.signature);
    if (!stillThere) {
      envelope = emptyEnvelope();
      entriesBySignature.clear();
    }
  }

  const retrySignatures = new Set(envelope.retrySignatures);
  // Discovery order matters for `seq` assignment (see module doc "Shape (v4)"): `forwardPending`
  // is newest-of-new-first (reversed before processing, below) and `backfillPending` is
  // newest-of-window-first (processed in that order directly).
  const forwardPending: string[] = [];
  const backfillPending: string[] = [];

  // --- Remote-first: merge in the worker's pre-built event index, if configured. -------------
  // Only requests `?after=<newest cached signature>` once this cache already reports `complete`
  // -- a `complete: true` response to that delta request means the worker's *whole* index is
  // complete, which combined with this cache's own completeness is enough to stay complete. If
  // this cache is incomplete (or empty), the request is for the full index (no `after`) instead,
  // so a `complete: true` response there is guaranteed to cover everything, not just a window
  // past a cursor the worker and this cache may disagree about. Either way, an incomplete,
  // unreachable, or mismatched response is ignored outright -- none of its entries are merged in
  // -- so the chain-based sync below (including the backfill cursor) runs completely unaffected.
  const localComplete = envelope.complete;
  const priorNewestSignature = sortedEntries(entriesBySignature).at(-1)?.signature;
  const remote = await fetchRemoteEvents(connection, programId, localComplete ? priorNewestSignature : undefined);
  let remoteComplete = false;
  if (remote !== null && remote.complete) {
    for (const entry of remote.entries) {
      entriesBySignature.set(entry.signature, entry);
      retrySignatures.delete(entry.signature);
    }
    remoteComplete = true;
  }

  // --- Forward sync: catch up to the chain head. ---------------------------
  const newestKnownSignature = sortedEntries(entriesBySignature).at(-1)?.signature;
  let backfillCursor = envelope.backfillCursor;
  let complete = envelope.complete || remoteComplete;

  if (newestKnownSignature !== undefined) {
    // Known history exists: page newest-first until that signature is
    // reached again. No page cap -- bounded naturally by the known
    // boundary, which is normally within one page for a periodic refresh.
    let before: string | undefined;
    let reachedKnown = false;
    while (!reachedKnown) {
      const batch = await connection.getSignaturesForAddress(programId, { limit: SIGNATURES_PAGE_SIZE, before });
      if (batch.length === 0) {
        break;
      }
      for (const { signature } of batch) {
        if (signature === newestKnownSignature) {
          reachedKnown = true;
          break;
        }
        if (!entriesBySignature.has(signature) && !retrySignatures.has(signature)) {
          forwardPending.push(signature);
        }
      }
      before = batch[batch.length - 1]?.signature;
      if (batch.length < SIGNATURES_PAGE_SIZE) {
        break;
      }
    }
  } else if (backfillCursor === undefined && !complete) {
    // True cold start: fetch one head page, process it now, and seed the
    // backfill cursor from its tail so older history is paged incrementally
    // on subsequent refreshes rather than all at once.
    const batch = await connection.getSignaturesForAddress(programId, { limit: SIGNATURES_PAGE_SIZE });
    for (const { signature } of batch) {
      if (!entriesBySignature.has(signature) && !retrySignatures.has(signature)) {
        forwardPending.push(signature);
      }
    }
    if (batch.length < SIGNATURES_PAGE_SIZE) {
      complete = true;
    } else {
      backfillCursor = batch[batch.length - 1]?.signature;
    }
  }

  // --- Backfill: continue paging toward the beginning, bounded per refresh. ---
  for (let page = 0; page < MAX_BACKFILL_PAGES_PER_REFRESH && !complete && backfillCursor !== undefined; page += 1) {
    const batch = await connection.getSignaturesForAddress(programId, {
      limit: SIGNATURES_PAGE_SIZE,
      before: backfillCursor,
    });
    if (batch.length === 0) {
      complete = true;
      break;
    }
    for (const { signature } of batch) {
      if (!entriesBySignature.has(signature) && !retrySignatures.has(signature)) {
        backfillPending.push(signature);
      }
    }
    backfillCursor = batch[batch.length - 1]?.signature;
    if (batch.length < SIGNATURES_PAGE_SIZE) {
      complete = true;
    }
  }

  // --- Assign `seq` and fetch/decode every pending signature. ---------------
  // `seq` only needs to be consistent as a same-slot tiebreaker (see module doc "Shape (v4)"), so
  // it's fine to derive fresh ranges each refresh from whatever's already in the map (including
  // anything the remote merge just added).
  let nextSeq = 1;
  let nextBackSeq = -1;
  for (const entry of entriesBySignature.values()) {
    if (entry.seq + 1 > nextSeq) nextSeq = entry.seq + 1;
    if (entry.seq - 1 < nextBackSeq) nextBackSeq = entry.seq - 1;
  }

  // Forward-discovered (and cold-start head page) signatures are newest-first; reverse so `seq`
  // increases in true chronological order.
  for (const signature of [...forwardPending].reverse()) {
    const entry = await fetchEntry(connection, programId, signature);
    await new Promise((resolve) => setTimeout(resolve, TRANSACTION_FETCH_SPACING_MS));
    if (entry === null) {
      retrySignatures.add(signature);
      continue;
    }
    entriesBySignature.set(signature, { ...entry, seq: nextSeq });
    nextSeq += 1;
    retrySignatures.delete(signature);
  }

  // Backfill-discovered signatures are already newest-of-window-first; assign decreasing `seq`
  // directly so older entries get smaller values.
  for (const signature of backfillPending) {
    const entry = await fetchEntry(connection, programId, signature);
    await new Promise((resolve) => setTimeout(resolve, TRANSACTION_FETCH_SPACING_MS));
    if (entry === null) {
      retrySignatures.add(signature);
      continue;
    }
    entriesBySignature.set(signature, { ...entry, seq: nextBackSeq });
    nextBackSeq -= 1;
    retrySignatures.delete(signature);
  }

  // Retry signatures from a previous refresh that failed to fetch/decode (item 14). Treated as
  // newest-batch appends: their exact chronological position relative to any same-slot sibling
  // discovered in a different refresh is not worth tracking across failed attempts.
  for (const signature of [...retrySignatures]) {
    if (entriesBySignature.has(signature)) {
      retrySignatures.delete(signature);
      continue;
    }
    const entry = await fetchEntry(connection, programId, signature);
    await new Promise((resolve) => setTimeout(resolve, TRANSACTION_FETCH_SPACING_MS));
    if (entry === null) {
      // Signature-paging cursors above have already moved past it -- there is nothing left to
      // re-page, only the transaction fetch to retry next refresh.
      continue;
    }
    entriesBySignature.set(signature, { ...entry, seq: nextSeq });
    nextSeq += 1;
    retrySignatures.delete(signature);
  }

  const finalEntries = sortedEntries(entriesBySignature);
  const nextEnvelope: CacheEnvelope = {
    version: CACHE_VERSION,
    entries: finalEntries,
    backfillCursor: complete ? undefined : backfillCursor,
    complete,
    retrySignatures: [...retrySignatures],
  };
  saveCache(key, nextEnvelope);

  return { events: finalEntries.flatMap((e) => e.events), complete };
}
