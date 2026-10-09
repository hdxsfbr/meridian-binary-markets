import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection, PublicKey as PublicKeyType } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { encodeEventForTest, Side, type FillData } from "@meridian/sdk";
import { EventIndex } from "../src/events-index";

const GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function pk(seed: number): PublicKeyType {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

function fillTx(programId: PublicKeyType, signature: string, slot: number) {
  const data: FillData = {
    market: pk(1),
    makerOrderId: BigInt(slot),
    maker: pk(2),
    taker: pk(3),
    sideOfTaker: Side.Ask,
    price: 500_000n,
    qty: 1n,
    ts: BigInt(slot),
  };
  const logs = [
    `Program ${programId.toBase58()} invoke [1]`,
    encodeEventForTest("Fill", data),
    `Program ${programId.toBase58()} success`,
  ];
  return {
    transaction: { signatures: [signature] },
    slot,
    blockTime: 1_700_000_000 + slot,
    meta: { err: null, logMessages: logs },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * A fake `Connection` backed by an ordered (newest-first) list of
 * signatures and a signature->tx map, with `getSignaturesForAddress`
 * honoring the real RPC's `before` cursor semantics (paged, newest-first).
 */
function mockConnection(
  signaturesNewestFirst: string[],
  txBySignature: Map<string, unknown>,
  opts: { genesisHash?: string; failSignatures?: Set<string> } = {},
): Connection {
  const genesisHash = opts.genesisHash ?? GENESIS_HASH;
  const failSignatures = opts.failSignatures ?? new Set<string>();
  return {
    getGenesisHash: async () => genesisHash,
    getSignatureStatuses: async (sigs: string[]) => ({
      value: sigs.map((sig) => (signaturesNewestFirst.includes(sig) ? {} : null)),
    }),
    getSignaturesForAddress: async (_programId: PublicKeyType, opts2: { limit: number; before?: string }) => {
      let startIdx = 0;
      if (opts2.before !== undefined) {
        const idx = signaturesNewestFirst.indexOf(opts2.before);
        startIdx = idx === -1 ? signaturesNewestFirst.length : idx + 1;
      }
      return signaturesNewestFirst.slice(startIdx, startIdx + opts2.limit).map((signature) => ({ signature }));
    },
    getParsedTransaction: async (signature: string) => {
      if (failSignatures.has(signature)) {
        throw new Error(`simulated fetch failure for ${signature}`);
      }
      return txBySignature.get(signature) ?? null;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "meridian-event-index-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("EventIndex", () => {
  it("builds the full index from a cold start and marks it complete", async () => {
    const programId = pk(99);
    const signatures = ["sig-3", "sig-2", "sig-1"]; // newest-first
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 100 - i)]));
    const connection = mockConnection(signatures, txs);

    const index = new EventIndex({
      connection,
      programId,
      snapshotPath: join(dir, "event-index.json"),
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });

    await index.start();
    index.stop();

    expect(index.entryCount).toBe(3);
    expect(index.isComplete).toBe(true);

    const payload = index.toPayload();
    expect(payload.complete).toBe(true);
    expect(payload.genesisHash).toBe(GENESIS_HASH);
    expect(payload.programId).toBe(programId.toBase58());
    expect(payload.entries.map((e) => e.signature)).toEqual(["sig-1", "sig-2", "sig-3"]); // oldest-first (by slot)
    expect(payload.newestSignature).toBe("sig-3");
  });

  it("persists a snapshot that a fresh instance resumes from without re-fetching", async () => {
    const programId = pk(99);
    const signatures = ["sig-2", "sig-1"];
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 10 - i)]));
    const connection = mockConnection(signatures, txs);
    const snapshotPath = join(dir, "event-index.json");

    const first = new EventIndex({ connection, programId, snapshotPath, fetchSpacingMs: 0, pollIntervalMs: 60_000 });
    await first.start();
    first.stop();

    const raw = JSON.parse(await readFile(snapshotPath, "utf8"));
    expect(raw.entries).toHaveLength(2);
    expect(raw.pagingComplete).toBe(true);
    expect(raw.retrySignatures).toEqual([]);

    // A fresh instance against a connection that now errors on any further
    // RPC call still ends up fully populated and complete purely from the
    // snapshot, proving a restart doesn't need the chain again once complete.
    let calls = 0;
    const strictConnection = {
      getGenesisHash: async () => GENESIS_HASH,
      getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(() => ({})) }),
      getSignaturesForAddress: async (_p: PublicKeyType, _o: unknown) => {
        calls += 1;
        return []; // no new signatures since the snapshot
      },
      getParsedTransaction: async () => {
        throw new Error("should not be called for already-known signatures");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const second = new EventIndex({
      connection: strictConnection,
      programId,
      snapshotPath,
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await second.start();
    second.stop();

    expect(second.entryCount).toBe(2);
    expect(second.isComplete).toBe(true);
    expect(calls).toBeGreaterThan(0); // it did poll for new signatures...
  });

  it("toPayload(after) returns only entries newer than the given signature", async () => {
    const programId = pk(99);
    const signatures = ["sig-3", "sig-2", "sig-1"];
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 30 - i * 10)]));
    const connection = mockConnection(signatures, txs);

    const index = new EventIndex({
      connection,
      programId,
      snapshotPath: join(dir, "event-index.json"),
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await index.start();
    index.stop();

    const payload = index.toPayload("sig-2");
    expect(payload.entries.map((e) => e.signature)).toEqual(["sig-3"]);
  });

  it("picks up new signatures on a subsequent sync() without losing already-indexed ones", async () => {
    const programId = pk(99);
    const signatures = ["sig-1"];
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 10 - i)]));
    const connection = mockConnection(signatures, txs);

    const index = new EventIndex({
      connection,
      programId,
      snapshotPath: join(dir, "event-index.json"),
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await index.start();
    expect(index.entryCount).toBe(1);

    // A new transaction lands; mutate the shared arrays the mock connection closed over.
    signatures.unshift("sig-2");
    txs.set("sig-2", fillTx(programId, "sig-2", 20));

    await index.sync();
    index.stop();

    expect(index.entryCount).toBe(2);
    expect(index.toPayload().newestSignature).toBe("sig-2");
  });

  it("ignores a snapshot written by a different program id", async () => {
    const programId = pk(99);
    const otherProgramId = pk(1);
    const snapshotPath = join(dir, "event-index.json");
    const signatures = ["sig-1"];
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(otherProgramId, sig, 10 - i)]));
    const connection = mockConnection(signatures, txs);

    const foreign = new EventIndex({ connection, programId: otherProgramId, snapshotPath, fetchSpacingMs: 0, pollIntervalMs: 60_000 });
    await foreign.start();
    foreign.stop();

    const emptyConnection = mockConnection([], new Map());
    const index = new EventIndex({ connection: emptyConnection, programId, snapshotPath, fetchSpacingMs: 0, pollIntervalMs: 60_000 });
    await index.start();
    index.stop();

    expect(index.entryCount).toBe(0);
  });

  it("retries a failed transaction fetch on every sync, independent of a newer success, and stays incomplete until it succeeds", async () => {
    const programId = pk(99);
    const signatures = ["sig-3", "sig-2", "sig-1"]; // newest-first
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 100 - i)]));
    const connection = mockConnection(signatures, txs, { failSignatures: new Set(["sig-2"]) });

    const index = new EventIndex({
      connection,
      programId,
      snapshotPath: join(dir, "event-index.json"),
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await index.start();

    // sig-2's fetch failed; sig-1 and sig-3 (chronologically straddling it) still indexed, but
    // the index must not report complete while sig-2 is outstanding.
    expect(index.entryCount).toBe(2);
    expect(index.isComplete).toBe(false);
    expect(index.toPayload().complete).toBe(false);

    // The underlying RPC call stops failing; a later sync() must retry sig-2 on its own, without
    // needing a new signature to "push" it along.
    connection.getParsedTransaction = async (signature: string) => txs.get(signature) ?? null;
    await index.sync();
    index.stop();

    expect(index.entryCount).toBe(3);
    expect(index.isComplete).toBe(true);
    expect(index.toPayload().complete).toBe(true);
  });

  it("orders entries sharing a slot by on-chain order (seq), not discovery order", async () => {
    const programId = pk(99);
    // All three transactions land in the same slot; on-chain order is sig-a (oldest) -> sig-b ->
    // sig-c (newest). getSignaturesForAddress returns newest-first: sig-c, sig-b, sig-a.
    const signatures = ["sig-c", "sig-b", "sig-a"];
    const txs = new Map(signatures.map((sig) => [sig, fillTx(programId, sig, 50)]));
    const connection = mockConnection(signatures, txs);

    const index = new EventIndex({
      connection,
      programId,
      snapshotPath: join(dir, "event-index.json"),
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await index.start();
    index.stop();

    expect(index.toPayload().entries.map((e) => e.signature)).toEqual(["sig-a", "sig-b", "sig-c"]);
  });

  it("rejects a snapshot whose genesisHash differs from the live chain and rebuilds from zero", async () => {
    const programId = pk(99);
    const snapshotPath = join(dir, "event-index.json");
    const signatures = ["sig-1"];
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 10 - i)]));

    const original = new EventIndex({
      connection: mockConnection(signatures, txs, { genesisHash: "OldGenesisHash1111111111111111111111111111" }),
      programId,
      snapshotPath,
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await original.start();
    original.stop();
    expect(original.entryCount).toBe(1);

    // A new chain identity (redeploy, or a devnet validator reset with a fresh key) reuses the
    // snapshot path but has no history of its own.
    const resumed = new EventIndex({
      connection: mockConnection([], new Map(), { genesisHash: "NewGenesisHash2222222222222222222222222222" }),
      programId,
      snapshotPath,
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await resumed.start();
    resumed.stop();

    expect(resumed.entryCount).toBe(0);
    expect(resumed.toPayload().genesisHash).toBe("NewGenesisHash2222222222222222222222222222");
  });

  it("rejects a snapshot whose oldest signature is no longer found on chain (same-genesis validator reset) and rebuilds from zero", async () => {
    const programId = pk(99);
    const snapshotPath = join(dir, "event-index.json");
    const signatures = ["sig-1"];
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 10 - i)]));

    const original = new EventIndex({
      connection: mockConnection(signatures, txs),
      programId,
      snapshotPath,
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await original.start();
    original.stop();
    expect(original.entryCount).toBe(1);

    // Same genesis hash, but the validator was reset locally: `sig-1` no longer exists on chain.
    const resumed = new EventIndex({
      connection: mockConnection([], new Map()), // getSignatureStatuses reports nothing found
      programId,
      snapshotPath,
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
    });
    await resumed.start();
    resumed.stop();

    expect(resumed.entryCount).toBe(0);
  });

  it("start() retries past an initial RPC error instead of leaving the index permanently stopped", async () => {
    const programId = pk(99);
    const signatures = ["sig-1"];
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 10 - i)]));
    const connection = mockConnection(signatures, txs);

    let genesisCalls = 0;
    const realGetGenesisHash = connection.getGenesisHash.bind(connection);
    connection.getGenesisHash = async () => {
      genesisCalls += 1;
      if (genesisCalls === 1) {
        throw new Error("simulated transient RPC error");
      }
      return realGetGenesisHash();
    };

    const sleeps: number[] = [];
    const index = new EventIndex({
      connection,
      programId,
      snapshotPath: join(dir, "event-index.json"),
      fetchSpacingMs: 0,
      pollIntervalMs: 60_000,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(index.start()).resolves.toBeUndefined();
    index.stop();

    expect(genesisCalls).toBeGreaterThan(1);
    expect(index.entryCount).toBe(1);
    expect(index.isComplete).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0); // backed off at least once before succeeding
  });

  it("checkpoints the backfill after each bounded batch so an in-process restart resumes instead of re-fetching everything", async () => {
    const programId = pk(99);
    const total = 1_300; // more than one SIGNATURES_PAGE_SIZE (1000) page
    const signatures = Array.from({ length: total }, (_, i) => `sig-${total - i}`); // newest-first
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, total - i)]));
    const snapshotPath = join(dir, "event-index.json");

    let getSignaturesCalls = 0;
    const connection = mockConnection(signatures, txs);
    const realGetSignatures = connection.getSignaturesForAddress.bind(connection);
    connection.getSignaturesForAddress = async (p: PublicKeyType, opts: { limit: number; before?: string }) => {
      getSignaturesCalls += 1;
      // Fail one call shortly after the first backfill batch (1000 signatures) has already been
      // fetched, decoded, and checkpointed to the snapshot -- simulating a transient RPC error
      // mid-backfill.
      if (getSignaturesCalls === 2) {
        throw new Error("simulated transient RPC error");
      }
      return realGetSignatures(p, opts);
    };

    const index = new EventIndex({ connection, programId, snapshotPath, fetchSpacingMs: 0, pollIntervalMs: 60_000 });
    await index.start();
    index.stop();

    // Despite the mid-backfill failure, start() retried (via retryForever) and resumed from the
    // checkpointed first batch rather than restarting the whole backfill.
    expect(index.entryCount).toBe(total);
    expect(index.isComplete).toBe(true);

    const raw = JSON.parse(await readFile(snapshotPath, "utf8"));
    expect(raw.entries).toHaveLength(total);
    expect(raw.pagingComplete).toBe(true);
  });

  it("writes the snapshot atomically (via a temp file + rename), leaving no stray temp files behind", async () => {
    const programId = pk(99);
    const signatures = ["sig-1"];
    const txs = new Map(signatures.map((sig, i) => [sig, fillTx(programId, sig, 10 - i)]));
    const snapshotPath = join(dir, "event-index.json");
    const connection = mockConnection(signatures, txs);

    const index = new EventIndex({ connection, programId, snapshotPath, fetchSpacingMs: 0, pollIntervalMs: 60_000 });
    await index.start();
    index.stop();

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    expect(files).toEqual(["event-index.json"]);
  });
});
