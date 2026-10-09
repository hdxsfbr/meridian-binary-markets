/**
 * In-memory, snapshot-persisted index of every decoded Meridian program
 * event. Lets the web app stop replaying the whole chain itself to build
 * cost basis/History (`web/src/lib/events-cache.ts`): the browser fetches
 * this index first (`GET /events` on the status server, see `status.ts`)
 * and only falls back to its own chain replay for whatever this index
 * hasn't caught up to yet.
 *
 * Mirrors the signature-paging and per-transaction decoding the web cache
 * does in the browser (same `getSignaturesForAddress` paging, same
 * `@meridian/sdk` `parseEventsFromTransaction` decoding), but runs
 * continuously server-side instead of being bounded by a 30s poll's time
 * budget.
 *
 * ## Completeness (`complete`)
 *
 * `complete` is only true once signature *paging* has reached the
 * beginning of program history (`pagingComplete`) *and* every signature
 * paging has ever discovered has been fetched and decoded successfully
 * (`retrySignatures` is empty). A transaction that fails to fetch/decode
 * goes into `retrySignatures` (persisted in the snapshot) and is retried on
 * every `sync()`, independent of the forward/backfill cursors -- those
 * cursors only ever need to re-page a signature that was never seen in the
 * first place, so a transient fetch failure can never wedge paging
 * progress, and `complete` correctly stays false until the retry succeeds.
 *
 * ## Total order (`seq`)
 *
 * `getSignaturesForAddress` returns newest-first, so within one page the
 * *later* array index is the *older* signature. Each entry gets a `seq`
 * assigned at discovery time: increasing for entries discovered while
 * paging forward (towards the chain head, where the oldest-of-the-new-page
 * is processed first so `seq` increases with time), decreasing for entries
 * discovered while paging backward (the cold backfill, towards genesis,
 * where discovery order already matches "newer first" so `seq` can just
 * count down as encountered). Sorting any set of entries by `(slot, seq)`
 * ascending reproduces true on-chain order even for multiple transactions
 * in the same slot -- the same total order `toPayload`/`toSerializedPayload`
 * use, and the same one `web/src/lib/events-cache.ts` uses when merging
 * this index's entries with its own chain-fetched ones.
 *
 * ## Cold backfill
 *
 * On a cold start (no usable snapshot), `start()` runs `sync()` repeatedly
 * -- each call pages and fetches exactly one bounded batch of backfill
 * (`backfillStep`, paced at `fetchSpacingMs` the same as transaction
 * fetches) and checkpoints a snapshot after it -- until paging reaches
 * genesis, then starts the `pollIntervalMs` timer for ongoing (normally
 * single-page) forward syncs. This bounds per-batch memory and means a
 * restart mid-backfill resumes from the last checkpointed batch instead of
 * re-paying for the whole history. `start()` itself never rejects and so
 * never leaves the index permanently stopped: genesis-hash resolution,
 * snapshot validation, and every sync (initial or polled) run through a
 * retry loop with exponential backoff capped at `pollIntervalMs`.
 *
 * ## Snapshot validation
 *
 * A snapshot is only installed once the *live* chain's genesis hash is
 * resolved and found to match the snapshot's (a mismatch means the program
 * was redeployed, or the devnet validator was reset with a fresh identity --
 * either way, the old entries are foreign history and are discarded). As a
 * second check (a same-genesis validator reset, e.g. local dev with
 * `--reset`, doesn't change the genesis hash but does wipe history), the
 * snapshot's oldest entry's signature must still resolve on chain
 * (`getSignatureStatuses`); if not, the whole snapshot is discarded and
 * rebuilt from zero, same as a missing/corrupt/foreign-programId snapshot.
 *
 * Persistence: snapshot writes go to a temp file in the same directory,
 * then rename over the target (atomic on the same filesystem), so a crash
 * mid-write can never leave a truncated/corrupt snapshot on disk. Railway's
 * disk is ephemeral, so a restart there is usually indistinguishable from a
 * true cold start (no snapshot file) -- handled the same way as a rejected
 * snapshot: the first backfill batch rebuilds from zero.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Connection, PublicKey } from "@solana/web3.js";
import {
  deserializeEntry,
  parseEventsFromTransaction,
  serializeEntry,
  serializeEventIndexPayload,
  EVENT_INDEX_VERSION,
  type EventIndexEntry,
  type EventIndexPayload,
  type MeridianEvent,
  type SerializedEventIndexEntry,
  type SerializedEventIndexPayload,
} from "@meridian/sdk";
import { log, logError } from "./log.js";

const SIGNATURES_PAGE_SIZE = 1000;

/** On-disk snapshot shape. Not the same as the `/events` wire payload: it also carries the
 * paging/retry bookkeeping needed to resume a cold backfill across restarts. */
type SnapshotFile = {
  version: number;
  programId: string;
  genesisHash: string;
  pagingComplete: boolean;
  backfillCursor: string | null;
  retrySignatures: string[];
  entries: SerializedEventIndexEntry[];
};

type FetchedEntry = { signature: string; slot: number; ts?: number; events: MeridianEvent[] };

export interface EventIndexOptions {
  connection: Connection;
  programId: PublicKey;
  /** Where the JSON snapshot is read/written. Created (including parent directories) if missing. */
  snapshotPath: string;
  /** Minimum spacing between `getParsedTransaction` calls (and between signature-paging calls). Default 200ms. */
  fetchSpacingMs?: number;
  /** How often the poll loop re-runs `sync()` once the initial backfill has caught up. Default 30s. */
  pollIntervalMs?: number;
  /** Injectable for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Program-wide event index: builds from the chain, polls for new signatures, and serves `GET /events`. */
export class EventIndex {
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly snapshotPath: string;
  private readonly fetchSpacingMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private entries = new Map<string, EventIndexEntry>();
  /** Signatures discovered (via `getSignaturesForAddress`) but not yet successfully fetched/decoded. */
  private retrySignatures = new Set<string>();
  /** True once signature paging has reached the beginning of program history. */
  private pagingComplete = false;
  /** Next `before` cursor for the cold backfill (older-than); `undefined` once `pagingComplete`. */
  private backfillCursor: string | undefined;
  private genesisHash = "";
  /** Next `seq` to assign to a newly forward-discovered entry. */
  private nextSeq = 0;
  /** Next `seq` to assign to a newly backfill-discovered entry. */
  private nextBackSeq = -1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing: Promise<void> | undefined;

  constructor(opts: EventIndexOptions) {
    this.connection = opts.connection;
    this.programId = opts.programId;
    this.snapshotPath = opts.snapshotPath;
    this.fetchSpacingMs = opts.fetchSpacingMs ?? 200;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Resolves the live genesis hash, loads (and validates) any existing
   * snapshot, then runs `sync()` in a bounded-batch loop until the cold
   * backfill reaches genesis, then starts the poll timer. Never rejects:
   * every step runs through `retryForever`, so a transient RPC error during
   * startup delays but never permanently stops the index.
   */
  async start(): Promise<void> {
    await this.retryForever(() => this.resolveGenesisHash(), "genesis_hash");
    await this.retryForever(() => this.loadSnapshotValidated(), "load_snapshot");
    do {
      await this.retryForever(() => this.sync(), "initial_backfill");
    } while (!this.pagingComplete);
    this.timer = setInterval(() => {
      void this.retryForever(() => this.sync(), "poll");
    }, this.pollIntervalMs);
  }

  /** Stops the poll timer. Does not clear in-memory state. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get isComplete(): boolean {
    return this.pagingComplete && this.retrySignatures.size === 0;
  }

  private sortedEntries(): EventIndexEntry[] {
    return [...this.entries.values()].sort((a, b) => a.slot - b.slot || a.seq - b.seq);
  }

  /** The decoded, in-memory payload, optionally narrowed to entries strictly newer than `after`. */
  toPayload(after?: string): EventIndexPayload {
    const sorted = this.sortedEntries();
    let entries = sorted;
    if (after !== undefined) {
      const idx = sorted.findIndex((e) => e.signature === after);
      entries = idx === -1 ? sorted : sorted.slice(idx + 1);
    }
    return {
      version: EVENT_INDEX_VERSION,
      programId: this.programId.toBase58(),
      genesisHash: this.genesisHash,
      complete: this.isComplete,
      newestSignature: sorted.at(-1)?.signature ?? null,
      entries,
    };
  }

  /** Same as `toPayload`, JSON-ready (pubkeys as base58, bigints as decimal strings). What `GET /events` writes to the response body. */
  toSerializedPayload(after?: string): SerializedEventIndexPayload {
    return serializeEventIndexPayload(this.toPayload(after));
  }

  // -------------------------------------------------------------------------
  // Retry-with-backoff helper (fix: `start()` never permanently stops).
  // -------------------------------------------------------------------------

  private async retryForever<T>(fn: () => Promise<T>, step: string): Promise<T> {
    let backoff = Math.min(this.fetchSpacingMs > 0 ? this.fetchSpacingMs : 50, this.pollIntervalMs);
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        logError({ job: "events-index", step, ok: false, error: (err as Error).message });
        await this.sleepFn(backoff);
        backoff = Math.min(backoff * 2, this.pollIntervalMs);
      }
    }
  }

  private async resolveGenesisHash(): Promise<void> {
    this.genesisHash = await this.connection.getGenesisHash();
  }

  // -------------------------------------------------------------------------
  // Snapshot load/validate/save.
  // -------------------------------------------------------------------------

  /** True if `signature` is still findable on chain. See module doc "Snapshot validation". */
  private async signatureStillOnChain(signature: string): Promise<boolean> {
    try {
      const result = await this.connection.getSignatureStatuses([signature]);
      return result.value[0] !== null;
    } catch {
      // Could not check (RPC flake): assume still valid rather than wiping a possibly-good
      // snapshot over a transient error.
      return true;
    }
  }

  private recomputeSeqCounters(): void {
    let max = -1;
    let min: number | undefined;
    for (const entry of this.entries.values()) {
      if (entry.seq > max) max = entry.seq;
      if (min === undefined || entry.seq < min) min = entry.seq;
    }
    this.nextSeq = max + 1;
    this.nextBackSeq = (min ?? 1) - 1;
  }

  private async loadSnapshotValidated(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.snapshotPath, "utf8");
    } catch {
      // No snapshot on disk -- first run, or Railway's ephemeral disk after a restart. A true
      // cold start, rebuilt from the chain in `sync()`/`start()`'s backfill loop.
      return;
    }
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      if (json.programId !== this.programId.toBase58()) {
        // A snapshot from a different deployment (program redeployed to a new address): treat
        // as absent rather than merging foreign history in.
        log({
          job: "events-index",
          step: "load_snapshot",
          ok: false,
          error: `snapshot programId ${String(json.programId)} does not match ${this.programId.toBase58()}; ignoring`,
        });
        return;
      }
      if (json.genesisHash !== this.genesisHash) {
        // Resolved *before* this call (see `start()`): a genesis mismatch means the chain
        // identity changed (redeploy, or a devnet validator reset with a fresh key) -- the old
        // entries are foreign history, discard and rebuild from zero.
        log({
          job: "events-index",
          step: "load_snapshot",
          ok: false,
          error: `snapshot genesisHash ${String(json.genesisHash)} does not match live chain ${this.genesisHash}; discarding and rebuilding from zero`,
        });
        return;
      }
      if (!Array.isArray(json.entries) || !Array.isArray(json.retrySignatures) || typeof json.pagingComplete !== "boolean") {
        throw new Error("malformed snapshot shape");
      }
      const entries = json.entries.map((e) => deserializeEntry(e));

      // Second check (same-genesis validator reset, e.g. local dev `--reset`): the oldest
      // entry's signature must still resolve on chain.
      const oldest = [...entries].sort((a, b) => a.slot - b.slot || a.seq - b.seq)[0];
      if (oldest !== undefined) {
        const stillThere = await this.signatureStillOnChain(oldest.signature);
        if (!stillThere) {
          log({
            job: "events-index",
            step: "load_snapshot",
            ok: false,
            error: `snapshot's oldest signature ${oldest.signature} no longer found on chain; discarding and rebuilding from zero`,
          });
          return;
        }
      }

      this.entries = new Map(entries.map((e) => [e.signature, e]));
      this.retrySignatures = new Set(json.retrySignatures as string[]);
      this.pagingComplete = json.pagingComplete;
      this.backfillCursor = (json.backfillCursor as string | null | undefined) ?? undefined;
      this.recomputeSeqCounters();
      log({ job: "events-index", step: "load_snapshot", ok: true, error: `${entries.length} entries` });
    } catch (err) {
      log({ job: "events-index", step: "load_snapshot", ok: false, error: (err as Error).message });
    }
  }

  private toSnapshotFile(): SnapshotFile {
    return {
      version: EVENT_INDEX_VERSION,
      programId: this.programId.toBase58(),
      genesisHash: this.genesisHash,
      pagingComplete: this.pagingComplete,
      backfillCursor: this.backfillCursor ?? null,
      retrySignatures: [...this.retrySignatures],
      entries: [...this.entries.values()].map(serializeEntry),
    };
  }

  /** Writes to a temp file in the same directory, then renames over the target (atomic on the same filesystem). */
  private async saveSnapshot(): Promise<void> {
    try {
      await mkdir(dirname(this.snapshotPath), { recursive: true });
      const tmpPath = `${this.snapshotPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await writeFile(tmpPath, JSON.stringify(this.toSnapshotFile()));
      await rename(tmpPath, this.snapshotPath);
    } catch (err) {
      logError({ job: "events-index", step: "save_snapshot", ok: false, error: (err as Error).message });
    }
  }

  // -------------------------------------------------------------------------
  // Transaction fetch + decode.
  // -------------------------------------------------------------------------

  private async fetchEntry(signature: string): Promise<FetchedEntry | null> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (tx === null) {
        return null;
      }
      const events = parseEventsFromTransaction(tx, this.programId);
      return { signature, slot: tx.slot, ts: tx.blockTime ?? undefined, events };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Sync passes.
  // -------------------------------------------------------------------------

  /**
   * One sync pass: retries previously-failed fetches, forward-syncs to the
   * chain head (if any entry is already known), and -- if paging hasn't
   * reached genesis yet -- runs one bounded, checkpointed backfill batch.
   * Concurrent calls share the same in-flight run.
   */
  async sync(): Promise<void> {
    if (this.syncing !== undefined) {
      return this.syncing;
    }
    const run = this.syncUncached().finally(() => {
      this.syncing = undefined;
    });
    this.syncing = run;
    return run;
  }

  private async syncUncached(): Promise<void> {
    await this.retryFailedSignatures();
    await this.forwardSync();
    if (!this.pagingComplete) {
      await this.backfillStep();
    }
    await this.saveSnapshot();
  }

  /** Retries every queued failed signature, independent of the forward/backfill cursors (fix: failed fetches no longer get stuck behind a newer success). */
  private async retryFailedSignatures(): Promise<void> {
    for (const signature of [...this.retrySignatures]) {
      const entry = await this.fetchEntry(signature);
      await this.sleepFn(this.fetchSpacingMs);
      if (entry !== null) {
        this.entries.set(signature, { ...entry, seq: this.nextSeq });
        this.nextSeq += 1;
        this.retrySignatures.delete(signature);
      }
    }
  }

  /**
   * Pages newest-first from the chain head until the already-known newest
   * signature is reached (normally one page for a periodic poll); a no-op
   * if nothing is known yet (the cold-start case is handled by
   * `backfillStep`). Newly-discovered signatures are fetched oldest-first
   * (reversing the newest-first discovery order) so `seq` increases in true
   * chronological order.
   */
  private async forwardSync(): Promise<void> {
    const newestKnown = this.sortedEntries().at(-1)?.signature;
    if (newestKnown === undefined) {
      return;
    }
    const discovered: string[] = [];
    let before: string | undefined;
    for (;;) {
      const batch = await this.connection.getSignaturesForAddress(this.programId, { limit: SIGNATURES_PAGE_SIZE, before });
      await this.sleepFn(this.fetchSpacingMs);
      if (batch.length === 0) {
        break;
      }
      let reachedKnown = false;
      for (const { signature } of batch) {
        if (signature === newestKnown) {
          reachedKnown = true;
          break;
        }
        if (!this.entries.has(signature) && !this.retrySignatures.has(signature)) {
          discovered.push(signature);
        }
      }
      if (reachedKnown) {
        break;
      }
      before = batch.at(-1)?.signature;
      if (batch.length < SIGNATURES_PAGE_SIZE) {
        break;
      }
    }

    discovered.reverse();
    for (const signature of discovered) {
      const entry = await this.fetchEntry(signature);
      await this.sleepFn(this.fetchSpacingMs);
      if (entry !== null) {
        this.entries.set(signature, { ...entry, seq: this.nextSeq });
        this.nextSeq += 1;
      } else {
        this.retrySignatures.add(signature);
      }
    }
  }

  /**
   * One bounded batch of the cold backfill: pages exactly one signature
   * page from `backfillCursor` (paced at `fetchSpacingMs`, same as
   * transaction fetches), fetches/decodes every newly-discovered signature
   * in that page (also paced), advances `backfillCursor`, and sets
   * `pagingComplete` once a page comes back short. Discovery order within
   * a page is newest-first, which already matches "assign decreasing `seq`
   * as discovered" for correct chronological order.
   */
  private async backfillStep(): Promise<void> {
    const batch = await this.connection.getSignaturesForAddress(this.programId, {
      limit: SIGNATURES_PAGE_SIZE,
      before: this.backfillCursor,
    });
    await this.sleepFn(this.fetchSpacingMs);
    if (batch.length === 0) {
      this.pagingComplete = true;
      return;
    }

    const discovered: string[] = [];
    for (const { signature } of batch) {
      if (!this.entries.has(signature) && !this.retrySignatures.has(signature)) {
        discovered.push(signature);
      }
    }

    for (const signature of discovered) {
      const entry = await this.fetchEntry(signature);
      await this.sleepFn(this.fetchSpacingMs);
      if (entry !== null) {
        this.entries.set(signature, { ...entry, seq: this.nextBackSeq });
        this.nextBackSeq -= 1;
      } else {
        this.retrySignatures.add(signature);
      }
    }

    this.backfillCursor = batch.at(-1)?.signature;
    if (batch.length < SIGNATURES_PAGE_SIZE) {
      this.pagingComplete = true;
    }
  }
}
