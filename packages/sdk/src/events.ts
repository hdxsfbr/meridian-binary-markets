/**
 * Decodes Meridian program events from transaction logs (data-model.md
 * "Events"; research.md R11: "The web app reconstructs positions and
 * realized P&L for the connected wallet from events via
 * `getSignaturesForAddress` on the wallet plus log parsing, cached in the
 * browser"). This module is the log-parsing half; `pnl.ts` is the
 * reconstruction half.
 *
 * Decoding uses `@anchor-lang/core`'s `BorshCoder`, built from the
 * generated `idl.ts`, so field names/types and 8-byte event discriminators
 * can never drift from `programs/meridian/src/events.rs`. The coder decodes
 * `u64`/`i64` fields to `BN` and `pubkey` fields to `PublicKey`; this module
 * converts every `BN` to a `bigint` (FR-008: no floats, and no `number`
 * either, on anything that can exceed 2^53) and leaves `PublicKey`s as-is.
 *
 * `encodeEventForTest` is the inverse used only by tests: it writes the
 * exact bytes the on-chain `emit!` would produce (discriminator from
 * `IDL.events`, fields in the same order as `programs/meridian/src/events.rs`
 * / `IDL.types`) so `events.test.ts` can round-trip without a validator.
 *
 * Event attribution uses `@anchor-lang/core`'s `EventParser`, scoped to this
 * program's id: it walks the transaction's CPI invocation stack so a
 * "Program data:" line emitted by some *other* program invoked in the same
 * transaction is never mistaken for one of ours (data-model.md "Events").
 * `Buffer` is used only by the ambient Node global (no `node:buffer` import,
 * matching `pda.ts`), and only inside `encodeEventForTest`'s test-only
 * encoder, so this module stays safe to pull into a browser bundle.
 */

import {
  PublicKey,
  type Connection,
  type ParsedTransactionWithMeta,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { BorshCoder, EventParser, type Idl } from "@anchor-lang/core";
import { IDL } from "#idl";
import { PROGRAM_ID_BASE58 } from "#program-id";
import { Side, tickerFromBytes, tickerSymbolBytes, type Ticker } from "#types";

const coder = new BorshCoder(IDL as unknown as Idl);

const DEFAULT_PROGRAM_ID = new PublicKey(PROGRAM_ID_BASE58);

/** The exact log-line prefix `sol_log_data`/Anchor's `emit!` produces; used only by `encodeEventForTest`. */
const PROGRAM_DATA_PREFIX = "Program data: ";

/** A decoded `u64`/`i64` arrives as a `BN`; this is the only shape this module relies on. */
type BNLike = { toString(base?: number): string };

function toBigInt(value: BNLike | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value.toString(10));
}

function toPublicKey(value: PublicKey): PublicKey {
  return value;
}

// ---------------------------------------------------------------------------
// Event data shapes (camelCase, bigint/PublicKey-typed), one per
// `programs/meridian/src/events.rs` struct.
// ---------------------------------------------------------------------------

export type MarketCreatedData = {
  market: PublicKey;
  ticker: Ticker;
  strike: bigint;
  tradingDay: number;
  closeTs: bigint;
};

export type MintedData = {
  market: PublicKey;
  user: PublicKey;
  qty: bigint;
};

export type PairRedeemedData = {
  market: PublicKey;
  user: PublicKey;
  qty: bigint;
};

export type OrderPlacedData = {
  market: PublicKey;
  orderId: bigint;
  owner: PublicKey;
  side: Side;
  price: bigint;
  qty: bigint;
};

export type OrderCancelledData = {
  market: PublicKey;
  orderId: bigint;
  owner: PublicKey;
  remainingRefunded: bigint;
};

export type FillData = {
  market: PublicKey;
  makerOrderId: bigint;
  maker: PublicKey;
  taker: PublicKey;
  sideOfTaker: Side;
  price: bigint;
  qty: bigint;
  ts: bigint;
};

export type SettledData = {
  market: PublicKey;
  price: bigint;
  outcome: 1 | 2;
  byOverride: boolean;
  ts: bigint;
};

export type WinningRedeemedData = {
  market: PublicKey;
  user: PublicKey;
  side: 1 | 2;
  qty: bigint;
  payout: bigint;
};

export type PausedData = {
  admin: PublicKey;
  ts: bigint;
};

export type UnpausedData = {
  admin: PublicKey;
  ts: bigint;
};

export type MeridianEvent =
  | { name: "MarketCreated"; data: MarketCreatedData; slot: number; signature: string; ts?: number }
  | { name: "Minted"; data: MintedData; slot: number; signature: string; ts?: number }
  | { name: "PairRedeemed"; data: PairRedeemedData; slot: number; signature: string; ts?: number }
  | { name: "OrderPlaced"; data: OrderPlacedData; slot: number; signature: string; ts?: number }
  | { name: "OrderCancelled"; data: OrderCancelledData; slot: number; signature: string; ts?: number }
  | { name: "Fill"; data: FillData; slot: number; signature: string; ts?: number }
  | { name: "Settled"; data: SettledData; slot: number; signature: string; ts?: number }
  | { name: "WinningRedeemed"; data: WinningRedeemedData; slot: number; signature: string; ts?: number }
  | { name: "Paused"; data: PausedData; slot: number; signature: string; ts?: number }
  | { name: "Unpaused"; data: UnpausedData; slot: number; signature: string; ts?: number };

export type MeridianEventName = MeridianEvent["name"];

/** `Extract<MeridianEvent, { name: N }>["data"]`, spelled out for callers of `encodeEventForTest`. */
export type MeridianEventData<N extends MeridianEventName> = Extract<MeridianEvent, { name: N }>["data"];

function outcomeSide(raw: number): 1 | 2 {
  if (raw !== 1 && raw !== 2) {
    throw new Error(`events: expected side/outcome 1 (Yes) or 2 (No), got ${raw}`);
  }
  return raw;
}

/**
 * Maps a raw Anchor-decoded event (snake_case field names, `BN`/`PublicKey`
 * values, straight off `coder.events.decode`) onto the typed, camelCase,
 * bigint shapes above. Throws on a name this module does not know about;
 * `parseEventsFromLogs` only ever calls this with `events.rs` names.
 */
function mapEventData(name: MeridianEventName, raw: Record<string, unknown>): MeridianEvent["data"] {
  switch (name) {
    case "MarketCreated":
      return {
        market: toPublicKey(raw.market as PublicKey),
        ticker: tickerFromBytes(Uint8Array.from(raw.ticker as ArrayLike<number>)),
        strike: toBigInt(raw.strike as BNLike),
        tradingDay: raw.trading_day as number,
        closeTs: toBigInt(raw.close_ts as BNLike),
      } satisfies MarketCreatedData;
    case "Minted":
      return {
        market: toPublicKey(raw.market as PublicKey),
        user: toPublicKey(raw.user as PublicKey),
        qty: toBigInt(raw.qty as BNLike),
      } satisfies MintedData;
    case "PairRedeemed":
      return {
        market: toPublicKey(raw.market as PublicKey),
        user: toPublicKey(raw.user as PublicKey),
        qty: toBigInt(raw.qty as BNLike),
      } satisfies PairRedeemedData;
    case "OrderPlaced":
      return {
        market: toPublicKey(raw.market as PublicKey),
        orderId: toBigInt(raw.order_id as BNLike),
        owner: toPublicKey(raw.owner as PublicKey),
        side: raw.side as Side,
        price: toBigInt(raw.price as BNLike),
        qty: toBigInt(raw.qty as BNLike),
      } satisfies OrderPlacedData;
    case "OrderCancelled":
      return {
        market: toPublicKey(raw.market as PublicKey),
        orderId: toBigInt(raw.order_id as BNLike),
        owner: toPublicKey(raw.owner as PublicKey),
        remainingRefunded: toBigInt(raw.remaining_refunded as BNLike),
      } satisfies OrderCancelledData;
    case "Fill":
      return {
        market: toPublicKey(raw.market as PublicKey),
        makerOrderId: toBigInt(raw.maker_order_id as BNLike),
        maker: toPublicKey(raw.maker as PublicKey),
        taker: toPublicKey(raw.taker as PublicKey),
        sideOfTaker: raw.side_of_taker as Side,
        price: toBigInt(raw.price as BNLike),
        qty: toBigInt(raw.qty as BNLike),
        ts: toBigInt(raw.ts as BNLike),
      } satisfies FillData;
    case "Settled":
      return {
        market: toPublicKey(raw.market as PublicKey),
        price: toBigInt(raw.price as BNLike),
        outcome: outcomeSide(raw.outcome as number),
        byOverride: raw.by_override as boolean,
        ts: toBigInt(raw.ts as BNLike),
      } satisfies SettledData;
    case "WinningRedeemed":
      return {
        market: toPublicKey(raw.market as PublicKey),
        user: toPublicKey(raw.user as PublicKey),
        side: outcomeSide(raw.side as number),
        qty: toBigInt(raw.qty as BNLike),
        payout: toBigInt(raw.payout as BNLike),
      } satisfies WinningRedeemedData;
    case "Paused":
      return {
        admin: toPublicKey(raw.admin as PublicKey),
        ts: toBigInt(raw.ts as BNLike),
      } satisfies PausedData;
    case "Unpaused":
      return {
        admin: toPublicKey(raw.admin as PublicKey),
        ts: toBigInt(raw.ts as BNLike),
      } satisfies UnpausedData;
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

/**
 * Decodes every Meridian event in `logs` (one transaction's `meta.logMessages`,
 * in order), attributed to `programId` via `@anchor-lang/core`'s
 * `EventParser`: it tracks the CPI invocation stack as it walks the logs, so
 * a "Program data:" line emitted while some *other* program is executing
 * (nested inside the same transaction) is never attributed to this program,
 * even though the raw bytes might happen to decode against this IDL. A
 * malformed log array (missing the "Program ... invoke/success" wrapper
 * lines every real transaction has -- e.g. a hand-built single-line array in
 * a test) yields no events rather than throwing.
 */
export function parseEventsFromLogs(
  logs: readonly string[],
  signature: string,
  slot: number,
  ts?: number,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): MeridianEvent[] {
  const out: MeridianEvent[] = [];
  const parser = new EventParser(programId, coder);
  try {
    for (const raw of parser.parseLogs([...logs])) {
      if (!KNOWN_EVENT_NAMES.has(raw.name)) {
        continue;
      }
      const name = raw.name as MeridianEventName;
      out.push({
        name,
        data: mapEventData(name, raw.data as Record<string, unknown>),
        slot,
        signature,
        ts,
      } as MeridianEvent);
    }
  } catch {
    // Not a well-formed transaction log array; no events to report.
  }
  return out;
}

/**
 * Decodes every Meridian event out of one already-fetched transaction,
 * attributed to `programId`. Skips entirely (returns `[]`) if the
 * transaction failed (`meta.err` is non-null): a failed transaction's
 * `emit!` calls are rolled back on chain and never actually happened.
 */
export function parseEventsFromTransaction(
  tx: ParsedTransactionWithMeta | VersionedTransactionResponse,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): MeridianEvent[] {
  if (tx.meta?.err) {
    return [];
  }
  const logs = tx.meta?.logMessages ?? [];
  const signature = tx.transaction.signatures[0] ?? "";
  const slot = tx.slot;
  const ts = tx.blockTime ?? undefined;
  return parseEventsFromLogs(logs, signature, slot, ts, programId);
}

export type FetchProgramEventsOptions = {
  /** Max signatures to page through. Defaults to 1000; paged in chunks of up to 1000 (the RPC max). */
  limit?: number;
  /** `getSignaturesForAddress`'s `before` cursor, for continuing a previous page. */
  before?: string;
};

/**
 * Pages `getSignaturesForAddress(programId)` (newest-first, as the RPC
 * returns it), fetches each parsed transaction, skips failed ones
 * (`meta.err`), and decodes every Meridian event attributed to `programId`
 * from it, returning the combined list oldest-first (the order a
 * position/P&L replay needs, R11). Signatures are deduplicated (a page
 * boundary landing mid-block can otherwise repeat one), so each transaction
 * is only ever decoded once.
 */
export async function fetchProgramEvents(
  connection: Connection,
  programId: PublicKey,
  options: FetchProgramEventsOptions = {},
): Promise<MeridianEvent[]> {
  const totalLimit = options.limit ?? 1000;

  const signatures: string[] = [];
  const seenSignatures = new Set<string>();
  let before = options.before;
  while (signatures.length < totalLimit) {
    const pageSize = Math.min(1000, totalLimit - signatures.length);
    const page = await connection.getSignaturesForAddress(programId, { limit: pageSize, before });
    if (page.length === 0) {
      break;
    }
    for (const { signature } of page) {
      if (!seenSignatures.has(signature)) {
        seenSignatures.add(signature);
        signatures.push(signature);
      }
    }
    before = page[page.length - 1]?.signature;
    if (page.length < pageSize) {
      break;
    }
  }

  // `signatures` is newest-first; replay oldest-first.
  signatures.reverse();

  const events: MeridianEvent[] = [];
  for (const signature of signatures) {
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (tx === null) {
      continue;
    }
    events.push(...parseEventsFromTransaction(tx, programId));
  }
  return events;
}

/** Every `PublicKey`-valued field name that might carry a wallet's address across `MeridianEvent.data`. */
const WALLET_FIELD_NAMES = ["user", "owner", "maker", "taker", "admin"] as const;

/** True if `wallet` appears in any of `event.data`'s wallet-shaped fields (`user`/`owner`/`maker`/`taker`/`admin`). */
function eventMentionsWallet(event: MeridianEvent, wallet: PublicKey): boolean {
  const data = event.data as Record<string, unknown>;
  for (const field of WALLET_FIELD_NAMES) {
    const value = data[field];
    if (value instanceof PublicKey && value.equals(wallet)) {
      return true;
    }
  }
  return false;
}

export type FetchWalletEventsOptions = FetchProgramEventsOptions;

/**
 * Thin wrapper over `fetchProgramEvents`: fetches every Meridian event for
 * `programId`, then keeps only the ones where `wallet` appears in some
 * wallet-shaped field (`user`/`owner`/`maker`/`taker`/`admin`). This is
 * deliberately *not* `getSignaturesForAddress(wallet)` -- a `Fill` where
 * `wallet` is the maker never appears in the wallet's own transaction
 * history (the maker's order was placed earlier; the taker's transaction is
 * the one that emits the `Fill`), so paging the wallet's signatures would
 * silently miss every maker fill.
 */
export async function fetchWalletEvents(
  connection: Connection,
  programId: PublicKey,
  wallet: PublicKey,
  options: FetchWalletEventsOptions = {},
): Promise<MeridianEvent[]> {
  const events = await fetchProgramEvents(connection, programId, options);
  return events.filter((event) => eventMentionsWallet(event, wallet));
}

// ---------------------------------------------------------------------------
// Test-only encoder: the inverse of `parseEventsFromLogs`, writing the exact
// bytes `emit!` produces (discriminator + borsh fields in events.rs order)
// so tests can round-trip without spinning up a validator.
// ---------------------------------------------------------------------------

function discriminatorFor(name: MeridianEventName): Buffer {
  const idlEvents = (IDL as unknown as { events: { name: string; discriminator: number[] }[] }).events;
  const entry = idlEvents.find((e) => e.name === name);
  if (!entry) {
    throw new Error(`encodeEventForTest: no discriminator for event "${name}" in IDL.events`);
  }
  return Buffer.from(entry.discriminator);
}

function pubkeyBytes(key: PublicKey): Buffer {
  return Buffer.from(key.toBytes());
}

function u8Byte(n: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(n & 0xff, 0);
  return b;
}

function boolByte(v: boolean): Buffer {
  return u8Byte(v ? 1 : 0);
}

function u32LE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt.asUintN(64, n), 0);
  return b;
}

function i64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt.asIntN(64, n), 0);
  return b;
}

function fixedBytes8(bytes: Uint8Array): Buffer {
  if (bytes.length !== 8) {
    throw new Error(`encodeEventForTest: expected 8 bytes, got ${bytes.length}`);
  }
  return Buffer.from(bytes);
}

/**
 * Encodes `data` as `name` would appear in a transaction log, as the exact
 * `"Program data: <base64>"` string `parseEventsFromLogs` expects. Field
 * order and types mirror `programs/meridian/src/events.rs` exactly (and are
 * cross-checked by `events.test.ts`'s round trip through the real decoder).
 */
export function encodeEventForTest<N extends MeridianEventName>(name: N, data: MeridianEventData<N>): string {
  const disc = discriminatorFor(name);
  let fields: Buffer;
  switch (name) {
    case "MarketCreated": {
      const d = data as MarketCreatedData;
      fields = Buffer.concat([
        pubkeyBytes(d.market),
        fixedBytes8(tickerSymbolBytes(d.ticker)),
        u64LE(d.strike),
        u32LE(d.tradingDay),
        i64LE(d.closeTs),
      ]);
      break;
    }
    case "Minted": {
      const d = data as MintedData;
      fields = Buffer.concat([pubkeyBytes(d.market), pubkeyBytes(d.user), u64LE(d.qty)]);
      break;
    }
    case "PairRedeemed": {
      const d = data as PairRedeemedData;
      fields = Buffer.concat([pubkeyBytes(d.market), pubkeyBytes(d.user), u64LE(d.qty)]);
      break;
    }
    case "OrderPlaced": {
      const d = data as OrderPlacedData;
      fields = Buffer.concat([
        pubkeyBytes(d.market),
        u64LE(d.orderId),
        pubkeyBytes(d.owner),
        u8Byte(d.side),
        u64LE(d.price),
        u64LE(d.qty),
      ]);
      break;
    }
    case "OrderCancelled": {
      const d = data as OrderCancelledData;
      fields = Buffer.concat([pubkeyBytes(d.market), u64LE(d.orderId), pubkeyBytes(d.owner), u64LE(d.remainingRefunded)]);
      break;
    }
    case "Fill": {
      const d = data as FillData;
      fields = Buffer.concat([
        pubkeyBytes(d.market),
        u64LE(d.makerOrderId),
        pubkeyBytes(d.maker),
        pubkeyBytes(d.taker),
        u8Byte(d.sideOfTaker),
        u64LE(d.price),
        u64LE(d.qty),
        i64LE(d.ts),
      ]);
      break;
    }
    case "Settled": {
      const d = data as SettledData;
      fields = Buffer.concat([pubkeyBytes(d.market), u64LE(d.price), u8Byte(d.outcome), boolByte(d.byOverride), i64LE(d.ts)]);
      break;
    }
    case "WinningRedeemed": {
      const d = data as WinningRedeemedData;
      fields = Buffer.concat([pubkeyBytes(d.market), pubkeyBytes(d.user), u8Byte(d.side), u64LE(d.qty), u64LE(d.payout)]);
      break;
    }
    case "Paused": {
      const d = data as PausedData;
      fields = Buffer.concat([pubkeyBytes(d.admin), i64LE(d.ts)]);
      break;
    }
    case "Unpaused": {
      const d = data as UnpausedData;
      fields = Buffer.concat([pubkeyBytes(d.admin), i64LE(d.ts)]);
      break;
    }
    default:
      throw new Error(`encodeEventForTest: unknown event name "${name as string}"`);
  }
  const bytes = Buffer.concat([disc, fields]);
  return `${PROGRAM_DATA_PREFIX}${bytes.toString("base64")}`;
}
