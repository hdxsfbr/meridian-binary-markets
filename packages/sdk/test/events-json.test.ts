import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  EVENT_INDEX_VERSION,
  deserializeEntry,
  deserializeEvent,
  deserializeEventIndexPayload,
  serializeEntry,
  serializeEvent,
  serializeEventIndexPayload,
  type EventIndexEntry,
  type EventIndexPayload,
} from "../src/events-json";
import type { FillData, MeridianEvent } from "../src/events";
import { Side } from "../src/types";

const SIGNATURE = "5TestSignature11111111111111111111111111111111111111111111111";

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

function fillEvent(): MeridianEvent {
  const data: FillData = {
    market: pk(1),
    makerOrderId: 42n,
    maker: pk(2),
    taker: pk(3),
    sideOfTaker: Side.Bid,
    price: 500_000n,
    qty: 1_000_000n,
    ts: 1_700_000_000n,
  };
  return { name: "Fill", data, slot: 123, signature: SIGNATURE, ts: 1_700_000_000 };
}

describe("events-json", () => {
  it("round-trips a Fill event through serialize/deserialize, pubkeys as base58 and bigints as decimal strings", () => {
    const event = fillEvent();
    const serialized = serializeEvent(event);

    expect(serialized.data.market).toBe(pk(1).toBase58());
    expect(serialized.data.makerOrderId).toBe("42");
    expect(serialized.data.price).toBe("500000");
    expect(typeof serialized.data.market).toBe("string");

    // Round-trips through an actual JSON string, not just the in-memory object.
    const roundTripped = deserializeEvent(JSON.parse(JSON.stringify(serialized)));
    expect(roundTripped).toEqual(event);
    expect((roundTripped.data as FillData).market.equals(pk(1))).toBe(true);
    expect((roundTripped.data as FillData).price).toBe(500_000n);
  });

  it("round-trips a full entry", () => {
    const entry: EventIndexEntry = { signature: SIGNATURE, slot: 123, seq: 5, ts: 1_700_000_000, events: [fillEvent()] };
    const roundTripped = deserializeEntry(JSON.parse(JSON.stringify(serializeEntry(entry))));
    expect(roundTripped).toEqual(entry);
  });

  it("round-trips a full index payload", () => {
    const payload: EventIndexPayload = {
      version: EVENT_INDEX_VERSION,
      programId: pk(9).toBase58(),
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      complete: true,
      newestSignature: SIGNATURE,
      entries: [{ signature: SIGNATURE, slot: 123, seq: 5, ts: 1_700_000_000, events: [fillEvent()] }],
    };
    const roundTripped = deserializeEventIndexPayload(JSON.parse(JSON.stringify(serializeEventIndexPayload(payload))));
    expect(roundTripped).toEqual(payload);
  });

  it("rejects a payload with the wrong version", () => {
    const bad = { version: 999, programId: "x", genesisHash: "y", complete: false, newestSignature: null, entries: [] };
    expect(() => deserializeEventIndexPayload(bad)).toThrow();
  });

  it("rejects an entry with a malformed public key field", () => {
    const bad = {
      signature: SIGNATURE,
      slot: 1,
      events: [{ name: "Fill", data: { ...serializeEvent(fillEvent()).data, market: "not-a-base58-key" }, slot: 1, signature: SIGNATURE }],
    };
    expect(() => deserializeEntry(bad)).toThrow();
  });

  it("rejects an unknown event name", () => {
    expect(() => deserializeEvent({ name: "SomethingElse", data: {}, slot: 1, signature: SIGNATURE })).toThrow();
  });
});
