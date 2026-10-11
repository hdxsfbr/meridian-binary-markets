/**
 * Same-origin proxy for the automation worker's event index (`GET /events`,
 * `GET /events?after=<signature>`), so a web deployment can point
 * `NEXT_PUBLIC_EVENTS_INDEX_URL` at `/api` (the client appends `/events`) and never depend on the
 * worker's CORS allow-list (which admits exactly one origin). The upstream base
 * URL comes from `EVENTS_INDEX_UPSTREAM`; the payload is passed through
 * untouched, so the browser-side validation in `lib/events-cache.ts`
 * (`programId` / `genesisHash`) still applies.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const upstream = process.env.EVENTS_INDEX_UPSTREAM?.replace(/\/$/, "");
  if (!upstream) {
    return NextResponse.json({ error: "EVENTS_INDEX_UPSTREAM is not configured" }, { status: 503 });
  }
  const after = new URL(request.url).searchParams.get("after");
  const target = after === null ? `${upstream}/events` : `${upstream}/events?after=${encodeURIComponent(after)}`;
  try {
    const response = await fetch(target, { cache: "no-store" });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
