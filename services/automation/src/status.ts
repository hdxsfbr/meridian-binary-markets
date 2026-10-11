/**
 * Status HTTP server (contracts/automation.md "Status endpoint"): read-only,
 * no auth, bound to the container network only. `GET /status` returns the
 * settlement job's in-memory map as JSON, plus (when the caller wires them
 * in, which `index.ts`'s `start` does) the heartbeat registry
 * (`job-registry.ts`'s `jobRegistry`) and the most recent `reconcile` pass
 * (`jobs/reconcile.ts`'s `lastReconcile`); `GET /healthz` is a trivial
 * liveness check; `GET /events` (optionally `?after=<signature>`) serves
 * the worker's program event index (`events-index.ts`) so the web app can
 * stop replaying the whole chain itself for cost basis/History. The admin
 * page is the only consumer of `/status` and shows "Status unavailable" if
 * it can't be reached -- this is the only way it learns *why* a market is
 * unsettled.
 *
 * Fix #22: the admin page runs on a different origin (`WEB_ORIGIN`, default
 * `http://localhost:3000`) than this service, so every response carries
 * `Access-Control-Allow-Origin` or the browser's `fetch` never sees the body.
 *
 * `new URL()` throws on a malformed request target (e.g. a client sending a
 * raw `//[` as the request line); that parse is wrapped in a try/catch and
 * answered with 400 rather than left to throw inside the request handler,
 * which would otherwise crash the whole process.
 */

import { createServer, type Server } from "node:http";
import type { SettlementStatusEntry } from "./jobs/settle.js";
import type { ReconcileReport } from "./jobs/reconcile.js";
import type { JobRegistrySnapshot } from "./job-registry.js";
import type { EventIndex } from "./events-index.js";

export interface StatusPayload {
  updatedAt: string;
  markets: Record<string, SettlementStatusEntry>;
  /** Heartbeat registry (job-registry.ts), when wired in -- omitted if the caller didn't pass one. */
  jobRegistry?: JobRegistrySnapshot;
  /** The most recent `reconcile` pass's report (jobs/reconcile.ts), when wired in. */
  lastReconcile?: ReconcileReport;
}

function buildPayload(
  statusMap: Map<string, SettlementStatusEntry>,
  getJobRegistry?: () => JobRegistrySnapshot,
  getLastReconcile?: () => ReconcileReport | undefined,
): StatusPayload {
  const markets: Record<string, SettlementStatusEntry> = {};
  for (const [key, entry] of statusMap) {
    markets[key] = entry;
  }
  const payload: StatusPayload = { updatedAt: new Date().toISOString(), markets };
  if (getJobRegistry) {
    payload.jobRegistry = getJobRegistry();
  }
  if (getLastReconcile) {
    const report = getLastReconcile();
    if (report) {
      payload.lastReconcile = report;
    }
  }
  return payload;
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
  eventIndex?: EventIndex,
  getJobRegistry?: () => JobRegistrySnapshot,
  getLastReconcile?: () => ReconcileReport | undefined,
): Server {
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", webOrigin);

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
      return;
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/status") {
      const payload = buildPayload(statusMap, getJobRegistry, getLastReconcile);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === "/events") {
      if (eventIndex === undefined) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "event index not available" }));
        return;
      }
      const after = url.searchParams.get("after") ?? undefined;
      const payload = eventIndex.toSerializedPayload(after);
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
