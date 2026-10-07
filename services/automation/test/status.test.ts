import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startStatusServer } from "../src/status";
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
});
