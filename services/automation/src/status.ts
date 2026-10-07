/**
 * Status HTTP server (contracts/automation.md "Status endpoint"): read-only,
 * no auth, bound to the container network only. `GET /status` returns the
 * settlement job's in-memory map as JSON; `GET /healthz` is a trivial
 * liveness check. The admin page is the only consumer and shows "Status
 * unavailable" if this can't be reached -- this is the only way it learns
 * *why* a market is unsettled.
 *
 * Fix #22: the admin page runs on a different origin (`WEB_ORIGIN`, default
 * `http://localhost:3000`) than this service, so every response carries
 * `Access-Control-Allow-Origin` or the browser's `fetch` never sees the body.
 */

import { createServer, type Server } from "node:http";
import type { SettlementStatusEntry } from "./jobs/settle.js";

export interface StatusPayload {
  updatedAt: string;
  markets: Record<string, SettlementStatusEntry>;
}

function buildPayload(statusMap: Map<string, SettlementStatusEntry>): StatusPayload {
  const markets: Record<string, SettlementStatusEntry> = {};
  for (const [key, entry] of statusMap) {
    markets[key] = entry;
  }
  return { updatedAt: new Date().toISOString(), markets };
}

/**
 * Starts the status server on `port`, reading live from `statusMap` on
 * every request (so updates from the settle job are reflected immediately,
 * with no caching layer to go stale).
 */
const DEFAULT_WEB_ORIGIN = "http://localhost:3000";

export function startStatusServer(
  port: number,
  statusMap: Map<string, SettlementStatusEntry>,
  webOrigin: string = DEFAULT_WEB_ORIGIN,
): Server {
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", webOrigin);

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/status") {
      const payload = buildPayload(statusMap);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port);
  return server;
}
