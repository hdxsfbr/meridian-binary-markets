/**
 * Decoder and matching simulator for the `Book` account (data-model.md:
 * 8-byte discriminator "MERIBOOK" + 120-byte header + capacity bids +
 * capacity asks, little-endian). Everything here is in Yes terms — bids are
 * Yes buyers, asks are Yes sellers — mirroring the on-chain layout exactly.
 * No perspective flipping lives here; that is `web/src/lib/book-perspective.ts`.
 */

import { PublicKey } from "@solana/web3.js";

export const BOOK_DISCRIMINATOR = "MERIBOOK";
const DISCRIMINATOR_LEN = 8;
const HEADER_LEN = 120;
const ORDER_LEN = 64;

export type BookHeader = {
  market: PublicKey;
  usdcEscrow: PublicKey;
  yesEscrow: PublicKey;
  nextOrderId: bigint;
  nextSeq: bigint;
  capacity: number;
  bidCount: number;
  askCount: number;
};

export type Order = {
  id: bigint;
  owner: PublicKey;
  price: bigint;
  remaining: bigint;
  seq: bigint;
};

export type Book = {
  header: BookHeader;
  bids: Order[];
  asks: Order[];
};

function discriminatorBytes(): Uint8Array {
  const out = new Uint8Array(DISCRIMINATOR_LEN);
  for (let i = 0; i < BOOK_DISCRIMINATOR.length; i += 1) {
    out[i] = BOOK_DISCRIMINATOR.charCodeAt(i);
  }
  return out;
}

function readPubkey(view: DataView, offset: number): PublicKey {
  return new PublicKey(new Uint8Array(view.buffer, view.byteOffset + offset, 32));
}

function readOrder(view: DataView, offset: number): Order {
  const id = view.getBigUint64(offset, true);
  const owner = readPubkey(view, offset + 8);
  const price = view.getBigUint64(offset + 40, true);
  const remaining = view.getBigUint64(offset + 48, true);
  const seq = view.getBigUint64(offset + 56, true);
  return { id, owner, price, remaining, seq };
}

/**
 * Decodes a `Book` account's raw bytes. Validates the 8-byte discriminator
 * and that `data.length === 8 + 120 + 2 * capacity * 64`. Returns only live
 * orders (`id !== 0n`) in stored order (bids then asks, slot order
 * preserved — the program keeps slots sorted, so this is already
 * price/seq order).
 */
export function decodeBook(data: Uint8Array): Book {
  if (data.length < DISCRIMINATOR_LEN + HEADER_LEN) {
    throw new Error(`decodeBook: data too short (${data.length} bytes)`);
  }

  const expectedDiscriminator = discriminatorBytes();
  for (let i = 0; i < DISCRIMINATOR_LEN; i += 1) {
    if (data[i] !== expectedDiscriminator[i]) {
      throw new Error(`decodeBook: bad discriminator`);
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerOffset = DISCRIMINATOR_LEN;

  const market = readPubkey(view, headerOffset);
  const usdcEscrow = readPubkey(view, headerOffset + 32);
  const yesEscrow = readPubkey(view, headerOffset + 64);
  const nextOrderId = view.getBigUint64(headerOffset + 96, true);
  const nextSeq = view.getBigUint64(headerOffset + 104, true);
  const capacity = view.getUint16(headerOffset + 112, true);
  const bidCount = view.getUint16(headerOffset + 114, true);
  const askCount = view.getUint16(headerOffset + 116, true);
  // bytes [headerOffset + 118, headerOffset + 120) are padding, ignored.

  const expectedLen = DISCRIMINATOR_LEN + HEADER_LEN + 2 * capacity * ORDER_LEN;
  if (data.length !== expectedLen) {
    throw new Error(
      `decodeBook: length mismatch (got ${data.length}, expected ${expectedLen} for capacity ${capacity})`,
    );
  }

  if (bidCount > capacity) {
    throw new Error(`decodeBook: bidCount ${bidCount} exceeds capacity ${capacity}`);
  }
  if (askCount > capacity) {
    throw new Error(`decodeBook: askCount ${askCount} exceeds capacity ${capacity}`);
  }

  const header: BookHeader = {
    market,
    usdcEscrow,
    yesEscrow,
    nextOrderId,
    nextSeq,
    capacity,
    bidCount,
    askCount,
  };

  /**
   * Reads exactly the live prefix `[0, count)` of a side's slots, verifying
   * the layout invariant: every slot inside the count holds a live order
   * (`id !== 0n`) and every slot at or beyond it is empty (`id === 0n`). A
   * violation means `bidCount`/`askCount` and the slot contents disagree --
   * corrupt data or a decode at the wrong offset -- so this throws rather
   * than silently returning a wrong order list.
   */
  function readLivePrefix(sideOffset: number, count: number, side: "bid" | "ask"): Order[] {
    const out: Order[] = [];
    for (let i = 0; i < capacity; i += 1) {
      const order = readOrder(view, sideOffset + i * ORDER_LEN);
      if (i < count) {
        if (order.id === 0n) {
          throw new Error(`decodeBook: ${side} slot ${i} has id 0 but is inside count ${count}`);
        }
        out.push(order);
      } else if (order.id !== 0n) {
        throw new Error(`decodeBook: ${side} slot ${i} has nonzero id ${order.id} but is beyond count ${count}`);
      }
    }
    return out;
  }

  const bodyOffset = DISCRIMINATOR_LEN + HEADER_LEN;
  const bids = readLivePrefix(bodyOffset, bidCount, "bid");

  const asksOffset = bodyOffset + capacity * ORDER_LEN;
  const asks = readLivePrefix(asksOffset, askCount, "ask");

  return { header, bids, asks };
}

/** Highest-priced live bid (best bid), by stored price-desc/seq-asc order, or undefined if empty. */
export function bestBid(book: Book): Order | undefined {
  return book.bids[0];
}

/** Lowest-priced live ask (best ask), by stored price-asc/seq-asc order, or undefined if empty. */
export function bestAsk(book: Book): Order | undefined {
  return book.asks[0];
}

export type DepthLevel = { price: bigint; qty: bigint };

/** Aggregates the first `levels` distinct price levels per side, summing `remaining` at equal price. */
export function depth(book: Book, levels: number): { bids: DepthLevel[]; asks: DepthLevel[] } {
  function aggregate(orders: Order[]): DepthLevel[] {
    const out: DepthLevel[] = [];
    for (const order of orders) {
      const last = out[out.length - 1];
      if (last !== undefined && last.price === order.price) {
        last.qty += order.remaining;
      } else {
        if (out.length >= levels) {
          break;
        }
        out.push({ price: order.price, qty: order.remaining });
      }
    }
    return out;
  }
  return { bids: aggregate(book.bids), asks: aggregate(book.asks) };
}

export type PlannedFill = {
  makerOrderId: bigint;
  maker: PublicKey;
  price: bigint;
  qty: bigint;
};

export type PlannedFillsResult = {
  fills: PlannedFill[];
  remaining: bigint;
};

/**
 * Mirrors the program's matching (research.md R8, T052 `match_taker`):
 * a `bid` taker takes `asks` with `price <= limitPrice`; an `ask` taker
 * takes `bids` with `price >= limitPrice`; maker's own price is used;
 * resting priority order (price-time, already the stored slot order) is
 * walked in sequence; capped at `maxFills` (program default/max 8).
 *
 * This is what a client uses to build the `remaining_accounts` list of
 * maker token accounts for `place_order`/`buy_no_market`/`sell_no_market`.
 */
/** The program's hard cap on fills per instruction (research.md R8 / T052). */
export const MAX_FILLS = 8;

export function plannedFills(
  book: Book,
  side: "bid" | "ask",
  limitPrice: bigint,
  qty: bigint,
  maxFills: number = MAX_FILLS,
): PlannedFillsResult {
  if (maxFills > MAX_FILLS) {
    throw new Error(`plannedFills: maxFills ${maxFills} exceeds the program's hard cap of ${MAX_FILLS}`);
  }
  const candidates = side === "bid" ? book.asks : book.bids;
  const fills: PlannedFill[] = [];
  let remaining = qty;

  for (const order of candidates) {
    if (remaining <= 0n || fills.length >= maxFills) {
      break;
    }
    const priceOk = side === "bid" ? order.price <= limitPrice : order.price >= limitPrice;
    if (!priceOk) {
      // Resting orders are stored best-first; once price no longer
      // qualifies, no later order in the slice can qualify either.
      break;
    }
    const fillQty = order.remaining < remaining ? order.remaining : remaining;
    if (fillQty <= 0n) {
      continue;
    }
    fills.push({ makerOrderId: order.id, maker: order.owner, price: order.price, qty: fillQty });
    remaining -= fillQty;
  }

  return { fills, remaining };
}

/** Test-only helper to build a raw `Book` account buffer matching the on-chain layout. */
export function encodeBookForTest(args: {
  market?: PublicKey;
  usdcEscrow?: PublicKey;
  yesEscrow?: PublicKey;
  nextOrderId?: bigint;
  nextSeq?: bigint;
  capacity: number;
  bids?: Order[];
  asks?: Order[];
}): Uint8Array {
  const capacity = args.capacity;
  const bids = args.bids ?? [];
  const asks = args.asks ?? [];
  if (bids.length > capacity || asks.length > capacity) {
    throw new Error("encodeBookForTest: more orders than capacity");
  }

  const total = DISCRIMINATOR_LEN + HEADER_LEN + 2 * capacity * ORDER_LEN;
  const buf = new Uint8Array(total);
  buf.set(discriminatorBytes(), 0);

  const view = new DataView(buf.buffer);
  const headerOffset = DISCRIMINATOR_LEN;
  const market = args.market ?? PublicKey.default;
  const usdcEscrow = args.usdcEscrow ?? PublicKey.default;
  const yesEscrow = args.yesEscrow ?? PublicKey.default;

  buf.set(market.toBytes(), headerOffset);
  buf.set(usdcEscrow.toBytes(), headerOffset + 32);
  buf.set(yesEscrow.toBytes(), headerOffset + 64);
  view.setBigUint64(headerOffset + 96, args.nextOrderId ?? 1n, true);
  view.setBigUint64(headerOffset + 104, args.nextSeq ?? 1n, true);
  view.setUint16(headerOffset + 112, capacity, true);
  view.setUint16(headerOffset + 114, bids.length, true);
  view.setUint16(headerOffset + 116, asks.length, true);
  // padding bytes [headerOffset + 118, headerOffset + 120) left zero.

  function writeOrder(offset: number, order: Order): void {
    view.setBigUint64(offset, order.id, true);
    buf.set(order.owner.toBytes(), offset + 8);
    view.setBigUint64(offset + 40, order.price, true);
    view.setBigUint64(offset + 48, order.remaining, true);
    view.setBigUint64(offset + 56, order.seq, true);
  }

  const bodyOffset = DISCRIMINATOR_LEN + HEADER_LEN;
  for (let i = 0; i < bids.length; i += 1) {
    writeOrder(bodyOffset + i * ORDER_LEN, bids[i]);
  }
  // remaining bid slots stay all-zero (id === 0n: empty slot).

  const asksOffset = bodyOffset + capacity * ORDER_LEN;
  for (let i = 0; i < asks.length; i += 1) {
    writeOrder(asksOffset + i * ORDER_LEN, asks[i]);
  }
  // remaining ask slots stay all-zero (id === 0n: empty slot).

  return buf;
}
