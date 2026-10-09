/**
 * Shared JSON (de)serialization for `MeridianEvent`s and the worker-served
 * event index payload (`services/automation/src/events-index.ts` writes it;
 * `web/src/lib/events-cache.ts` reads it). A single shared format means
 * neither side can drift from the other on how a `PublicKey` or `bigint`
 * round-trips through `JSON.stringify`/`JSON.parse`.
 *
 * Unlike the browser cache's own tagged generic walker (`{__bigint}`/
 * `{__pubkey}` markers, kept private to `events-cache.ts` for its
 * `localStorage` envelope), this module knows the exact shape of each
 * `events.rs` event (mirroring `mapEventData` in `events.ts`) and emits the
 * plain, self-describing format called for by the worker's `/events`
 * contract: every `PublicKey` as its base58 string, every `bigint` as its
 * decimal string, everything else as-is. That only works because each
 * field's (de)serializer is written explicitly per event name below, rather
 * than inferred from the runtime value the way the generic walker does.
 */

import { PublicKey } from "@solana/web3.js";
import type {
  FillData,
  MarketCreatedData,
  MeridianEvent,
  MeridianEventName,
  MintedData,
  OrderCancelledData,
  OrderPlacedData,
  PairRedeemedData,
  PausedData,
  SettledData,
  UnpausedData,
  WinningRedeemedData,
} from "#events";

/** Current snapshot/wire format version for the event index payload. Bump on any shape change. */
export const EVENT_INDEX_VERSION = 1;

/** JSON-safe serialized form of one `MeridianEvent`: `PublicKey` fields are base58 strings, `bigint` fields are decimal strings. */
export type SerializedMeridianEvent = {
  name: MeridianEventName;
  data: Record<string, unknown>;
  slot: number;
  signature: string;
  ts?: number;
};

/**
 * One transaction's worth of decoded events, the same granularity the web cache and the worker
 * index both key by signature. `seq` is a total-order tiebreaker for entries that share a `slot`:
 * the worker and the browser cache both derive it from signature-discovery order (which, because
 * `getSignaturesForAddress` returns newest-first, is the reverse of on-chain order), so sorting
 * any collection of entries by `(slot, seq)` ascending reproduces true chronological order even
 * when a slot contains more than one of this program's transactions. It is not meaningful on its
 * own across independently-sourced entries (e.g. one producer's `seq` space vs. another's) outside
 * of that same-slot tiebreak role.
 */
export type EventIndexEntry = {
  signature: string;
  slot: number;
  seq: number;
  ts?: number;
  events: MeridianEvent[];
};

export type SerializedEventIndexEntry = {
  signature: string;
  slot: number;
  seq: number;
  ts?: number;
  events: SerializedMeridianEvent[];
};

/** The worker's `GET /events` response body. */
export type EventIndexPayload = {
  version: number;
  programId: string;
  genesisHash: string;
  /** True once the worker's backfill has reached the beginning of program history. */
  complete: boolean;
  /** Newest signature in `entries`, or `null` if `entries` is empty. */
  newestSignature: string | null;
  entries: EventIndexEntry[];
};

export type SerializedEventIndexPayload = {
  version: number;
  programId: string;
  genesisHash: string;
  complete: boolean;
  newestSignature: string | null;
  entries: SerializedEventIndexEntry[];
};

class EventJsonError extends Error {}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new EventJsonError(`events-json: expected "${field}" to be a string, got ${typeof value}`);
  }
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new EventJsonError(`events-json: expected "${field}" to be a number, got ${typeof value}`);
  }
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new EventJsonError(`events-json: expected "${field}" to be a boolean, got ${typeof value}`);
  }
  return value;
}

function pkToJson(value: PublicKey): string {
  return value.toBase58();
}

function pkFromJson(value: unknown, field: string): PublicKey {
  try {
    return new PublicKey(expectString(value, field));
  } catch (err) {
    throw new EventJsonError(`events-json: "${field}" is not a valid base58 public key: ${(err as Error).message}`);
  }
}

function bigToJson(value: bigint): string {
  return value.toString();
}

function bigFromJson(value: unknown, field: string): bigint {
  const str = expectString(value, field);
  try {
    return BigInt(str);
  } catch {
    throw new EventJsonError(`events-json: "${field}" is not a valid decimal bigint string: ${str}`);
  }
}

function outcomeFromJson(value: unknown, field: string): 1 | 2 {
  const n = expectNumber(value, field);
  if (n !== 1 && n !== 2) {
    throw new EventJsonError(`events-json: expected "${field}" to be 1 or 2, got ${n}`);
  }
  return n;
}

/** Serializes one event's `data` per its known shape (mirrors `mapEventData` in `events.ts`). */
function serializeData(name: MeridianEventName, data: MeridianEvent["data"]): Record<string, unknown> {
  switch (name) {
    case "MarketCreated": {
      const d = data as MarketCreatedData;
      return {
        market: pkToJson(d.market),
        ticker: d.ticker,
        strike: bigToJson(d.strike),
        tradingDay: d.tradingDay,
        closeTs: bigToJson(d.closeTs),
      };
    }
    case "Minted": {
      const d = data as MintedData;
      return { market: pkToJson(d.market), user: pkToJson(d.user), qty: bigToJson(d.qty) };
    }
    case "PairRedeemed": {
      const d = data as PairRedeemedData;
      return { market: pkToJson(d.market), user: pkToJson(d.user), qty: bigToJson(d.qty) };
    }
    case "OrderPlaced": {
      const d = data as OrderPlacedData;
      return {
        market: pkToJson(d.market),
        orderId: bigToJson(d.orderId),
        owner: pkToJson(d.owner),
        side: d.side,
        price: bigToJson(d.price),
        qty: bigToJson(d.qty),
      };
    }
    case "OrderCancelled": {
      const d = data as OrderCancelledData;
      return {
        market: pkToJson(d.market),
        orderId: bigToJson(d.orderId),
        owner: pkToJson(d.owner),
        remainingRefunded: bigToJson(d.remainingRefunded),
      };
    }
    case "Fill": {
      const d = data as FillData;
      return {
        market: pkToJson(d.market),
        makerOrderId: bigToJson(d.makerOrderId),
        maker: pkToJson(d.maker),
        taker: pkToJson(d.taker),
        sideOfTaker: d.sideOfTaker,
        price: bigToJson(d.price),
        qty: bigToJson(d.qty),
        ts: bigToJson(d.ts),
      };
    }
    case "Settled": {
      const d = data as SettledData;
      return {
        market: pkToJson(d.market),
        price: bigToJson(d.price),
        outcome: d.outcome,
        byOverride: d.byOverride,
        ts: bigToJson(d.ts),
      };
    }
    case "WinningRedeemed": {
      const d = data as WinningRedeemedData;
      return {
        market: pkToJson(d.market),
        user: pkToJson(d.user),
        side: d.side,
        qty: bigToJson(d.qty),
        payout: bigToJson(d.payout),
      };
    }
    case "Paused": {
      const d = data as PausedData;
      return { admin: pkToJson(d.admin), ts: bigToJson(d.ts) };
    }
    case "Unpaused": {
      const d = data as UnpausedData;
      return { admin: pkToJson(d.admin), ts: bigToJson(d.ts) };
    }
  }
}

/** Inverse of `serializeData`; throws `EventJsonError` on a malformed/foreign payload rather than silently coercing. */
function deserializeData(name: MeridianEventName, raw: Record<string, unknown>): MeridianEvent["data"] {
  switch (name) {
    case "MarketCreated":
      return {
        market: pkFromJson(raw.market, "data.market"),
        ticker: expectString(raw.ticker, "data.ticker"),
        strike: bigFromJson(raw.strike, "data.strike"),
        tradingDay: expectNumber(raw.tradingDay, "data.tradingDay"),
        closeTs: bigFromJson(raw.closeTs, "data.closeTs"),
      } satisfies MarketCreatedData;
    case "Minted":
      return {
        market: pkFromJson(raw.market, "data.market"),
        user: pkFromJson(raw.user, "data.user"),
        qty: bigFromJson(raw.qty, "data.qty"),
      } satisfies MeridianEvent["data"];
    case "PairRedeemed":
      return {
        market: pkFromJson(raw.market, "data.market"),
        user: pkFromJson(raw.user, "data.user"),
        qty: bigFromJson(raw.qty, "data.qty"),
      } satisfies MeridianEvent["data"];
    case "OrderPlaced":
      return {
        market: pkFromJson(raw.market, "data.market"),
        orderId: bigFromJson(raw.orderId, "data.orderId"),
        owner: pkFromJson(raw.owner, "data.owner"),
        side: expectNumber(raw.side, "data.side") as OrderPlacedData["side"],
        price: bigFromJson(raw.price, "data.price"),
        qty: bigFromJson(raw.qty, "data.qty"),
      } satisfies OrderPlacedData;
    case "OrderCancelled":
      return {
        market: pkFromJson(raw.market, "data.market"),
        orderId: bigFromJson(raw.orderId, "data.orderId"),
        owner: pkFromJson(raw.owner, "data.owner"),
        remainingRefunded: bigFromJson(raw.remainingRefunded, "data.remainingRefunded"),
      } satisfies OrderCancelledData;
    case "Fill":
      return {
        market: pkFromJson(raw.market, "data.market"),
        makerOrderId: bigFromJson(raw.makerOrderId, "data.makerOrderId"),
        maker: pkFromJson(raw.maker, "data.maker"),
        taker: pkFromJson(raw.taker, "data.taker"),
        sideOfTaker: expectNumber(raw.sideOfTaker, "data.sideOfTaker") as FillData["sideOfTaker"],
        price: bigFromJson(raw.price, "data.price"),
        qty: bigFromJson(raw.qty, "data.qty"),
        ts: bigFromJson(raw.ts, "data.ts"),
      } satisfies FillData;
    case "Settled":
      return {
        market: pkFromJson(raw.market, "data.market"),
        price: bigFromJson(raw.price, "data.price"),
        outcome: outcomeFromJson(raw.outcome, "data.outcome"),
        byOverride: expectBoolean(raw.byOverride, "data.byOverride"),
        ts: bigFromJson(raw.ts, "data.ts"),
      } satisfies SettledData;
    case "WinningRedeemed":
      return {
        market: pkFromJson(raw.market, "data.market"),
        user: pkFromJson(raw.user, "data.user"),
        side: outcomeFromJson(raw.side, "data.side"),
        qty: bigFromJson(raw.qty, "data.qty"),
        payout: bigFromJson(raw.payout, "data.payout"),
      } satisfies WinningRedeemedData;
    case "Paused":
      return {
        admin: pkFromJson(raw.admin, "data.admin"),
        ts: bigFromJson(raw.ts, "data.ts"),
      } satisfies PausedData;
    case "Unpaused":
      return {
        admin: pkFromJson(raw.admin, "data.admin"),
        ts: bigFromJson(raw.ts, "data.ts"),
      } satisfies UnpausedData;
    default:
      throw new EventJsonError(`events-json: unknown event name "${String(name)}"`);
  }
}

const KNOWN_EVENT_NAMES: ReadonlySet<string> = new Set<MeridianEventName>([
  "MarketCreated",
  "Minted",
  "PairRedeemed",
  "OrderPlaced",
  "OrderCancelled",
  "Fill",
  "Settled",
  "WinningRedeemed",
  "Paused",
  "Unpaused",
]);

export function serializeEvent(event: MeridianEvent): SerializedMeridianEvent {
  return {
    name: event.name,
    data: serializeData(event.name, event.data),
    slot: event.slot,
    signature: event.signature,
    ts: event.ts,
  };
}

export function deserializeEvent(raw: unknown): MeridianEvent {
  if (raw === null || typeof raw !== "object") {
    throw new EventJsonError("events-json: expected an event object");
  }
  const r = raw as Record<string, unknown>;
  const name = expectString(r.name, "name");
  if (!KNOWN_EVENT_NAMES.has(name)) {
    throw new EventJsonError(`events-json: unknown event name "${name}"`);
  }
  if (r.data === null || typeof r.data !== "object") {
    throw new EventJsonError("events-json: expected \"data\" to be an object");
  }
  const eventName = name as MeridianEventName;
  return {
    name: eventName,
    data: deserializeData(eventName, r.data as Record<string, unknown>),
    slot: expectNumber(r.slot, "slot"),
    signature: expectString(r.signature, "signature"),
    ts: r.ts === undefined ? undefined : expectNumber(r.ts, "ts"),
  } as MeridianEvent;
}

export function serializeEntry(entry: EventIndexEntry): SerializedEventIndexEntry {
  return {
    signature: entry.signature,
    slot: entry.slot,
    seq: entry.seq,
    ts: entry.ts,
    events: entry.events.map(serializeEvent),
  };
}

export function deserializeEntry(raw: unknown): EventIndexEntry {
  if (raw === null || typeof raw !== "object") {
    throw new EventJsonError("events-json: expected an entry object");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.events)) {
    throw new EventJsonError('events-json: expected entry "events" to be an array');
  }
  return {
    signature: expectString(r.signature, "signature"),
    slot: expectNumber(r.slot, "slot"),
    seq: expectNumber(r.seq, "seq"),
    ts: r.ts === undefined ? undefined : expectNumber(r.ts, "ts"),
    events: r.events.map(deserializeEvent),
  };
}

export function serializeEventIndexPayload(payload: EventIndexPayload): SerializedEventIndexPayload {
  return {
    version: payload.version,
    programId: payload.programId,
    genesisHash: payload.genesisHash,
    complete: payload.complete,
    newestSignature: payload.newestSignature,
    entries: payload.entries.map(serializeEntry),
  };
}

/**
 * Inverse of `serializeEventIndexPayload`. Throws `EventJsonError` on any
 * shape mismatch (wrong version, missing fields, corrupt entries) so
 * callers (the worker reloading its own snapshot, the web app validating a
 * remote fetch) can catch and fall back rather than operate on bad data.
 */
export function deserializeEventIndexPayload(raw: unknown): EventIndexPayload {
  if (raw === null || typeof raw !== "object") {
    throw new EventJsonError("events-json: expected a payload object");
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== EVENT_INDEX_VERSION) {
    throw new EventJsonError(`events-json: expected version ${EVENT_INDEX_VERSION}, got ${String(r.version)}`);
  }
  if (!Array.isArray(r.entries)) {
    throw new EventJsonError('events-json: expected payload "entries" to be an array');
  }
  if (r.newestSignature !== null && typeof r.newestSignature !== "string") {
    throw new EventJsonError('events-json: expected payload "newestSignature" to be a string or null');
  }
  return {
    version: r.version,
    programId: expectString(r.programId, "programId"),
    genesisHash: expectString(r.genesisHash, "genesisHash"),
    complete: expectBoolean(r.complete, "complete"),
    newestSignature: r.newestSignature as string | null,
    entries: r.entries.map(deserializeEntry),
  };
}

export { EventJsonError };
