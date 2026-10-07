"use client";

/**
 * Polls the automation service's `GET /status` endpoint
 * (`NEXT_PUBLIC_AUTOMATION_STATUS_URL`, contracts/automation.md) every 10s.
 * This is the only way `/admin` learns *why* a market is unsettled (attempts,
 * last error, next retry, override-available time) — see
 * `specs/001-binary-outcome-markets/contracts/frontend.md`.
 *
 * Falls back to `unavailable: true` (never throws, never blanks a previous
 * good snapshot) when the URL is unset or the service cannot be reached, so
 * the admin page can show "Status unavailable" instead of a crash.
 */

import { useEffect, useState } from "react";
import type { StatusMap } from "@/lib/admin-view";

const POLL_INTERVAL_MS = 10_000;

const STATUS_URL = process.env.NEXT_PUBLIC_AUTOMATION_STATUS_URL;

type RawStatusResponse = {
  updatedAt: number;
  markets: Record<
    string,
    {
      ticker: string;
      strike: string | number;
      attempts: number;
      lastError: string | null;
      lastAttemptAt: number | null;
      nextRetryAt: number | null;
      overrideAvailableAt: number | null;
      settled: boolean;
    }
  >;
};

export type UseStatusResult = {
  /** The decoded `markets` map, or `null` while unavailable/not yet loaded. */
  status: StatusMap | null;
  /** True when the endpoint is unset, unreachable, or returned a bad shape. */
  unavailable: boolean;
};

function decode(raw: RawStatusResponse): StatusMap {
  const out: StatusMap = {};
  for (const [pubkey, entry] of Object.entries(raw.markets ?? {})) {
    out[pubkey] = {
      ticker: entry.ticker,
      strike: String(entry.strike),
      attempts: Number(entry.attempts),
      lastError: entry.lastError ?? null,
      lastAttemptAt: entry.lastAttemptAt ?? null,
      nextRetryAt: entry.nextRetryAt ?? null,
      overrideAvailableAt: entry.overrideAvailableAt ?? null,
      settled: Boolean(entry.settled),
    };
  }
  return out;
}

/** Live `{ status, unavailable }` for the automation service's status map, polled every 10s. */
export function useStatus(): UseStatusResult {
  const [status, setStatus] = useState<StatusMap | null>(null);
  const [unavailable, setUnavailable] = useState(STATUS_URL === undefined);

  useEffect(() => {
    if (STATUS_URL === undefined) {
      setUnavailable(true);
      return;
    }

    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(STATUS_URL as string, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`status endpoint returned ${response.status}`);
        }
        const raw = (await response.json()) as RawStatusResponse;
        if (cancelled) {
          return;
        }
        setStatus(decode(raw));
        setUnavailable(false);
      } catch {
        if (cancelled) {
          return;
        }
        // Keep the previous snapshot (if any) rather than blanking it; mark
        // unavailable so the page can show the fallback copy alongside it.
        setUnavailable(true);
      }
    }

    void poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { status, unavailable };
}
