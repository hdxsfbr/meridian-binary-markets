import { PublicKey, type Connection } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_INDEX_VERSION,
  encodeEventForTest,
  serializeEventIndexPayload,
  type EventIndexPayload,
  type MintedData,
} from "@meridian/sdk";
import { fetchRemoteEvents, refreshEventCacheDetailed } from "./events-cache";

const GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SIGNATURE = "5TestSignature11111111111111111111111111111111111111111111111";

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

function mintedPayload(programId: PublicKey, overrides: Partial<EventIndexPayload> = {}): EventIndexPayload {
  const data: MintedData = { market: pk(1), user: pk(2), qty: 7n };
  return {
    version: EVENT_INDEX_VERSION,
    programId: programId.toBase58(),
    genesisHash: GENESIS_HASH,
    complete: true,
    newestSignature: SIGNATURE,
    entries: [{ signature: SIGNATURE, slot: 100, seq: 0, ts: 1_700_000_000, events: [{ name: "Minted", data, slot: 100, signature: SIGNATURE, ts: 1_700_000_000 }] }],
    ...overrides,
  };
}

/** A fake `Connection` that never finds anything new on chain -- isolates the remote-fetch behavior from the chain-replay path. */
function emptyChainConnection(genesisHash: string = GENESIS_HASH): Connection {
  return {
    getGenesisHash: async () => genesisHash,
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(() => ({})) }),
    getSignaturesForAddress: async () => [],
    getParsedTransaction: async () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function mockFetchOnce(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      json: async () => body,
    })),
  );
}

describe("fetchRemoteEvents", () => {
  const programId = pk(9);

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_EVENTS_INDEX_URL", "https://worker.example.com");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns null when the URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_EVENTS_INDEX_URL", "");
    mockFetchOnce(serializeEventIndexPayload(mintedPayload(programId)));
    const result = await fetchRemoteEvents(emptyChainConnection(), programId, undefined);
    expect(result).toBeNull();
  });

  it("returns the decoded entries and completeness on a valid, matching payload", async () => {
    mockFetchOnce(serializeEventIndexPayload(mintedPayload(programId)));
    const result = await fetchRemoteEvents(emptyChainConnection(), programId, undefined);
    expect(result).not.toBeNull();
    expect(result!.complete).toBe(true);
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].signature).toBe(SIGNATURE);
    expect(result!.entries[0].events[0].name).toBe("Minted");
    const data = result!.entries[0].events[0].data as MintedData;
    expect(data.qty).toBe(7n);
    expect(data.market.equals(pk(1))).toBe(true);
  });

  it("passes the after cursor through as a query param", async () => {
    mockFetchOnce(serializeEventIndexPayload(mintedPayload(programId)));
    await fetchRemoteEvents(emptyChainConnection(), programId, "someOlderSig");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][0]).toBe("https://worker.example.com/events?after=someOlderSig");
  });

  it("ignores a payload whose programId does not match (mismatch guard)", async () => {
    mockFetchOnce(serializeEventIndexPayload(mintedPayload(pk(123))));
    const result = await fetchRemoteEvents(emptyChainConnection(), programId, undefined);
    expect(result).toBeNull();
  });

  it("ignores a payload whose genesisHash does not match the browser's own connection (mismatch guard)", async () => {
    mockFetchOnce(serializeEventIndexPayload(mintedPayload(programId, { genesisHash: "someOtherGenesisHash" })));
    const result = await fetchRemoteEvents(emptyChainConnection(GENESIS_HASH), programId, undefined);
    expect(result).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    mockFetchOnce({}, false);
    const result = await fetchRemoteEvents(emptyChainConnection(), programId, undefined);
    expect(result).toBeNull();
  });

  it("returns null when the body fails shape validation", async () => {
    mockFetchOnce({ version: 999, bogus: true });
    const result = await fetchRemoteEvents(emptyChainConnection(), programId, undefined);
    expect(result).toBeNull();
  });

  it("returns null when fetch itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await fetchRemoteEvents(emptyChainConnection(), programId, undefined);
    expect(result).toBeNull();
  });
});

describe("refreshEventCacheDetailed (remote-first merge)", () => {
  const programId = pk(9);

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_EVENTS_INDEX_URL", "https://worker.example.com");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("merges the worker's entries into the result and reports complete from the payload", async () => {
    mockFetchOnce(serializeEventIndexPayload(mintedPayload(programId)));
    const result = await refreshEventCacheDetailed(emptyChainConnection(), programId);
    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].name).toBe("Minted");
  });

  it("falls back to the chain replay result when the remote payload is mismatched", async () => {
    // Wrong genesisHash: fetchRemoteEvents rejects it, so none of its (fake) events should
    // appear in the result -- the connection's own (empty) chain history is the only source.
    mockFetchOnce(serializeEventIndexPayload(mintedPayload(programId, { genesisHash: "wrongGenesisHash" })));
    const result = await refreshEventCacheDetailed(emptyChainConnection(GENESIS_HASH), programId);
    expect(result.events).toHaveLength(0);
  });

  it("falls back to the chain replay result when the remote fetch fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await refreshEventCacheDetailed(emptyChainConnection(), programId);
    expect(result.events).toHaveLength(0);
  });

  it("ignores an incomplete remote payload entirely rather than partially merging its entries", async () => {
    // The worker reports complete: false (its own backfill hasn't caught up yet). Even though it
    // did return one entry, none of it should be merged in -- partial coverage must never look
    // like a (partial) success to the cache.
    mockFetchOnce(serializeEventIndexPayload(mintedPayload(programId, { complete: false })));
    const result = await refreshEventCacheDetailed(emptyChainConnection(), programId);
    expect(result.events).toHaveLength(0);
    // The chain itself has no history either (emptyChainConnection), so a short page means the
    // chain-based backfill alone reaches `complete: true` -- proving completeness came from the
    // chain replay, not from the ignored remote payload.
    expect(result.complete).toBe(true);
  });

  it("keeps on-chain order for a same-slot batch after merge (same total order the worker uses: slot, then seq)", async () => {
    // Three of this program's transactions land in the same slot. getSignaturesForAddress
    // returns newest-first: sig-c, sig-b, sig-a -- true on-chain order is sig-a (oldest) -> sig-b
    // -> sig-c (newest).
    const signatures = ["sig-c", "sig-b", "sig-a"];
    const qtyBySignature: Record<string, bigint> = { "sig-a": 1n, "sig-b": 2n, "sig-c": 3n };

    const connection = {
      getGenesisHash: async () => GENESIS_HASH,
      getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(() => ({})) }),
      getSignaturesForAddress: async (_p: PublicKey, opts: { before?: string }) =>
        opts.before === undefined ? signatures.map((signature) => ({ signature })) : [],
      getParsedTransaction: async (signature: string) => {
        const data: MintedData = { market: pk(1), user: pk(2), qty: qtyBySignature[signature] };
        const programIdStr = programId.toBase58();
        const logs = [
          `Program ${programIdStr} invoke [1]`,
          encodeEventForTest("Minted", data),
          `Program ${programIdStr} success`,
        ];
        return {
          transaction: { signatures: [signature] },
          slot: 50,
          blockTime: 1_700_000_000,
          meta: { err: null, logMessages: logs },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Connection;

    // No remote worker configured for this test -- isolates the chain-replay merge/ordering.
    vi.stubEnv("NEXT_PUBLIC_EVENTS_INDEX_URL", "");

    const result = await refreshEventCacheDetailed(connection, programId);
    expect(result.events.map((e) => (e.data as MintedData).qty)).toEqual([1n, 2n, 3n]);
  });
});
