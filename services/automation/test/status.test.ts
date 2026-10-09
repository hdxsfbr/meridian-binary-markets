import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { Connection, PublicKey as PublicKeyType } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { startStatusServer } from "../src/status";
import { EventIndex } from "../src/events-index";
import type { SettlementStatusEntry } from "../src/jobs/settle";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return fetch(`http://127.0.0.1:${port}${path}`).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

describe("status server", () => {
  it("GET /status returns the settlement status map as JSON", async () => {
    const map = new Map<string, SettlementStatusEntry>();
    map.set("MarketPubkey111", {
      market: "MarketPubkey111",
      ticker: "META",
      strike: "680000000",
      attempts: 2,
      lastError: "OracleStale",
      lastAttemptAt: "2026-10-06T20:00:00.000Z",
      nextRetryAt: "2026-10-06T20:00:30.000Z",
      overrideAvailableAt: "2026-10-06T21:00:00.000Z",
      settled: false,
    });

    const port = 18787 + Math.floor(Math.random() * 1000);
    server = startStatusServer(port, map);

    const { status, body } = await get(port, "/status");
    expect(status).toBe(200);
    const payload = body as { updatedAt: string; markets: Record<string, SettlementStatusEntry> };
    expect(typeof payload.updatedAt).toBe("string");
    expect(payload.markets["MarketPubkey111"].ticker).toBe("META");
    expect(payload.markets["MarketPubkey111"].attempts).toBe(2);
  });

  it("GET /healthz returns ok", async () => {
    const port = 19787 + Math.floor(Math.random() * 1000);
    server = startStatusServer(port, new Map());

    const { status, body } = await get(port, "/healthz");
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it("returns 400 instead of crashing on a malformed request target that new URL() can't parse", async () => {
    const port = 22787 + Math.floor(Math.random() * 1000);
    server = startStatusServer(port, new Map());

    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        // A raw request line `new URL()` throws on (e.g. an unescaped `[` in the path), but
        // Node's own HTTP parser accepts as `req.url`.
        socket.write("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => {
        const match = /^HTTP\/1\.1 (\d+)/.exec(data);
        resolve(match ? Number(match[1]) : 0);
      });
      socket.on("error", reject);
    });

    expect(status).toBe(400);
  });

  it("GET /events returns 503 when no event index is wired in", async () => {
    const port = 20787 + Math.floor(Math.random() * 1000);
    server = startStatusServer(port, new Map());

    const { status } = await get(port, "/events");
    expect(status).toBe(503);
  });

  it("GET /events and GET /events?after=<sig> serve the event index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meridian-status-events-"));
    try {
      const programId: PublicKeyType = new PublicKey(new Uint8Array(32).fill(7));
      const connection = {
        getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        getSignaturesForAddress: async (_p: PublicKeyType, opts: { before?: string }) =>
          opts.before === undefined ? [{ signature: "sig-2" }, { signature: "sig-1" }] : [],
        getParsedTransaction: async (signature: string) => ({
          transaction: { signatures: [signature] },
          slot: signature === "sig-2" ? 20 : 10,
          blockTime: 1_700_000_000,
          meta: { err: null, logMessages: [] },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Connection;

      const eventIndex = new EventIndex({
        connection,
        programId,
        snapshotPath: join(dir, "event-index.json"),
        fetchSpacingMs: 0,
        pollIntervalMs: 60_000,
      });
      await eventIndex.start();
      eventIndex.stop();

      const port = 21787 + Math.floor(Math.random() * 1000);
      server = startStatusServer(port, new Map(), undefined, eventIndex);

      const full = await get(port, "/events");
      expect(full.status).toBe(200);
      const fullBody = full.body as { complete: boolean; newestSignature: string; entries: unknown[] };
      expect(fullBody.complete).toBe(true);
      expect(fullBody.newestSignature).toBe("sig-2");
      expect(fullBody.entries).toHaveLength(2);

      const narrowed = await get(port, "/events?after=sig-1");
      expect(narrowed.status).toBe(200);
      const narrowedBody = narrowed.body as { entries: Array<{ signature: string }> };
      expect(narrowedBody.entries.map((e) => e.signature)).toEqual(["sig-2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
