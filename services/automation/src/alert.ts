/**
 * Shared job alerting (contracts/automation.md "Alert payload"): POSTs
 * `ALERT_WEBHOOK_URL` and always writes to stderr at `error` level. No alert
 * is ever sent for a successful settle -- the settle job only invokes this on
 * the unsettled-after-15-minutes path (FR-032). The morning job also uses
 * this module: one alert per ticker whose ladder could not be completed,
 * sent after every enabled ticker has been attempted (PRD §5.3).
 */

import { DateTime } from "luxon";
import { ET_ZONE } from "./calendar.js";
import { logError } from "./log.js";

export interface AlertInput {
  /** Defaults to "settle" so existing settle call sites don't need to set this. */
  job?: "settle" | "morning";
  ticker: string;
  error: string;
  /**
   * ISO 8601 UTC timestamp: when `admin_settle_override` becomes available
   * (`close_ts + delay`). Settle-only -- omitted (and the "Override
   * available at..." sentence dropped) for jobs with no override concept,
   * e.g. morning.
   */
  overrideAvailableAtEt?: string;
  market?: string;
  /** Overrides the default "unsettled after 15 min" lead phrase, e.g. morning's ladder-creation failures. */
  summary?: string;
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
  const summary = input.summary ?? "unsettled after 15 min";
  const base = `Meridian: ${input.ticker} ${summary} — ${input.error}.`;
  if (!input.overrideAvailableAtEt) return base;
  const formatted = formatOverrideAvailableAt(input.overrideAvailableAtEt);
  return `${base} Override available at ${formatted}.`;
}

/**
 * Sends a job alert per contracts/automation.md: POSTs `webhookUrl`
 * with `{"text": "..."}` and always logs to stderr. If `webhookUrl` is
 * unset, the POST is skipped and a warning is logged instead (no throw --
 * a missing webhook must never crash the calling job).
 */
export async function alert(
  input: AlertInput,
  webhookUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const job = input.job ?? "settle";
  const text = alertText(input);

  logError({
    job,
    ticker: input.ticker,
    market: input.market,
    step: "alert",
    ok: false,
    error: input.error,
  });

  if (!webhookUrl) {
    logError({
      job,
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
        job,
        ticker: input.ticker,
        market: input.market,
        step: "alert",
        ok: false,
        error: `ALERT_WEBHOOK_URL rejected the alert: HTTP ${response.status}`,
      });
    }
  } catch (err) {
    logError({
      job,
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
