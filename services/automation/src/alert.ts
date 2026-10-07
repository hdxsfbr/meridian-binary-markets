/**
 * Settlement alerting (contracts/automation.md "Alert payload"): POSTs
 * `ALERT_WEBHOOK_URL` and always writes to stderr at `error` level. No alert
 * is ever sent for a successful settle -- callers only invoke this on the
 * unsettled-after-15-minutes path (FR-032).
 */

import { DateTime } from "luxon";
import { ET_ZONE } from "./calendar.js";
import { logError } from "./log.js";

export interface AlertInput {
  ticker: string;
  error: string;
  /** ISO 8601 UTC timestamp: when `admin_settle_override` becomes available (`close_ts + delay`). */
  overrideAvailableAtEt: string;
  market?: string;
}

/** 5 s request timeout for the alert webhook POST (fix #20). */
const ALERT_TIMEOUT_MS = 5_000;

/**
 * Formats a UTC ISO timestamp in America/New_York with its zone abbreviation
 * (e.g. "2026-10-06 16:00:00 EDT"), per fix #21 -- the field is a UTC
 * instant and must be converted, not just relabeled "ET".
 */
function formatOverrideAvailableAt(isoUtc: string): string {
  const dt = DateTime.fromISO(isoUtc, { zone: "utc" }).setZone(ET_ZONE);
  if (!dt.isValid) {
    return isoUtc;
  }
  return `${dt.toFormat("yyyy-MM-dd HH:mm:ss")} ${dt.offsetNameShort}`;
}

function alertText(input: AlertInput): string {
  const formatted = formatOverrideAvailableAt(input.overrideAvailableAtEt);
  return (
    `Meridian: ${input.ticker} unsettled after 15 min — ${input.error}. ` +
    `Override available at ${formatted}.`
  );
}

/**
 * Sends the settlement alert per contracts/automation.md: POSTs `webhookUrl`
 * with `{"text": "..."}` and always logs to stderr. If `webhookUrl` is
 * unset, the POST is skipped and a warning is logged instead (no throw --
 * a missing webhook must never crash the settle job).
 */
export async function alert(
  input: AlertInput,
  webhookUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = alertText(input);

  logError({
    job: "settle",
    ticker: input.ticker,
    market: input.market,
    step: "alert",
    ok: false,
    error: input.error,
  });

  if (!webhookUrl) {
    logError({
      job: "settle",
      ticker: input.ticker,
      market: input.market,
      step: "alert",
      ok: false,
      error: "ALERT_WEBHOOK_URL is unset; alert was not sent anywhere",
    });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    // Fix #20: a non-2xx response is a failed delivery, not a success --
    // `fetch` only rejects on network-level failures, never on HTTP status.
    if (!response.ok) {
      logError({
        job: "settle",
        ticker: input.ticker,
        market: input.market,
        step: "alert",
        ok: false,
        error: `ALERT_WEBHOOK_URL rejected the alert: HTTP ${response.status}`,
      });
    }
  } catch (err) {
    logError({
      job: "settle",
      ticker: input.ticker,
      market: input.market,
      step: "alert",
      ok: false,
      error: `failed to POST ALERT_WEBHOOK_URL: ${(err as Error).message}`,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
