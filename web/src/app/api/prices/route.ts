/**
 * `GET /api/prices?ids=<hex>,<hex>`: latest Hermes prices for the given
 * feed ids, for display when the on-chain oracle provider is Pyth (the mock
 * provider writes prices on chain and needs no proxy). Runs server-side so
 * the Pyth key never reaches the browser: `PYTH_API_KEY`, or the file at
 * `PYTH_API_KEY_FILE` (default `/run/keys/pyth_api_key`, the container's
 * read-only key mount). Responses are cached for a few seconds per id set.
 */

import { hermesToDisplayPrices, type DisplayPrice } from "@/lib/hermes-prices";
import { pythApiKey } from "@/lib/pyth-key";

export const dynamic = "force-dynamic";

const HERMES_URL = process.env.PYTH_HERMES_URL ?? "https://pyth.dourolabs.app/hermes";
const CACHE_TTL_MS = 5_000;
const MAX_IDS = 16;
const cache = new Map<string, { at: number; body: Record<string, DisplayPrice> }>();

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^0x/, ""))
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
  if (ids.length === 0 || ids.length > MAX_IDS) {
    return Response.json({ error: "ids: 1 to 16 feed ids as 64-char hex" }, { status: 400 });
  }
  const key = pythApiKey();
  if (key === undefined) {
    return Response.json({ error: "price source not configured" }, { status: 503 });
  }
  const cacheKey = ids.slice().sort().join(",");
  const hit = cache.get(cacheKey);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json(hit.body);
  }
  const body = await fetchPricesTolerant(ids, key);
  if (body === null) {
    return Response.json({ error: "price source unavailable" }, { status: 502 });
  }
  cache.set(cacheKey, { at: Date.now(), body });
  return Response.json(body);
}

/** Feed ids Hermes has refused as "not entitled" (status 403), skipped for a while so one
 *  ungranted feed never blanks every other price in the batch. */
const unentitled = new Map<string, number>();
const UNENTITLED_TTL_MS = 10 * 60_000;

async function fetchBatch(ids: string[], key: string): Promise<{ ok: true; body: unknown } | { ok: false; status: number; text: string }> {
  const query = ids.map((id) => `ids[]=${id}`).join("&");
  const upstream = await fetch(`${HERMES_URL}/v2/updates/price/latest?${query}&parsed=true`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, text: await upstream.text().catch(() => "") };
  }
  return { ok: true, body: await upstream.json() };
}

/**
 * Fetches the batch, dropping any feed Hermes reports as not entitled (it names the id in
 * its 403 body) and retrying with the rest, up to the number of ids. Returns the prices it
 * could get (possibly empty), or null only when the source is down for every id.
 */
async function fetchPricesTolerant(ids: string[], key: string): Promise<Record<string, DisplayPrice> | null> {
  const now = Date.now();
  let remaining = ids.filter((id) => {
    const until = unentitled.get(id);
    return until === undefined || until < now;
  });
  for (let attempt = 0; attempt <= ids.length; attempt += 1) {
    if (remaining.length === 0) return {};
    const result = await fetchBatch(remaining, key);
    if (result.ok) return hermesToDisplayPrices(result.body);
    const match = result.status === 403 ? /([0-9a-f]{64})/i.exec(result.text) : null;
    if (match === null) return attempt === 0 ? null : {};
    unentitled.set(match[1].toLowerCase(), now + UNENTITLED_TTL_MS);
    remaining = remaining.filter((id) => id.toLowerCase() !== match[1].toLowerCase());
  }
  return {};
}
