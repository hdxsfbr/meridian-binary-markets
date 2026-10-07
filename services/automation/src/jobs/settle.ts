/**
 * `settle` job (contracts/automation.md, tasks.md T045/T047): for every
 * `Open` market whose `close_ts <= now`, grouped by ticker, publishes a
 * price once per ticker and settles every market on that ticker. On a guard
 * or RPC error the ticker retries every 30 s until 15 minutes after the job
 * started, then alerts once and stops retrying that ticker.
 * `AlreadySettled` counts as success (FR-021). The in-memory
 * `SettlementStatus` map is updated after every attempt and exported for
 * `status.ts`.
 *
 * Fix #4: exactly one closing observation is published per ticker per
 * trading day (`closeObservation`, cached and reused for every strike and
 * every retry that day) rather than re-publishing a fresh live quote on
 * every retry, which would let different strikes (or different retries of
 * the same strike) settle against different prices. A pre-close observation
 * is never cached or used to settle.
 *
 * Fix #16: retry attempts are scheduled against fixed timestamps
 * (`start + n * retryIntervalMs`), and the 15-minute alert deadline is
 * checked *before* starting an attempt, not after.
 *
 * Fix #17: before every retry and before alerting, each still-pending
 * market is re-fetched from chain; one already `Settled` (e.g. by another
 * caller) is reconciled as success and dropped, rather than retried or
 * alerted on forever.
 */

import type { PublicKey } from "@solana/web3.js";
import type { Ticker } from "@meridian/sdk";
import { isAlreadySettledError, type MarketAccount, type MarketRecord } from "../chain.js";
import { tradingDayOf } from "../calendar.js";
import { log } from "../log.js";
import { alert as defaultAlert, type AlertInput } from "../alert.js";
import type { PriceProvider } from "../providers/PriceProvider.js";
import { ENTITLEMENT_REMINDER, HermesError } from "../sources/hermes.js";

const RETRY_INTERVAL_MS = 30_000;
const ALERT_WINDOW_MS = 15 * 60_000;

export interface SettleChain {
  fetchOpenMarkets(tradingDay?: number): Promise<MarketRecord[]>;
  fetchConfig(): Promise<{ overrideDelaySecs: number }>;
  settleMarket(market: PublicKey, priceAccount: PublicKey): Promise<void>;
  /** Fix #17: used to reconcile a pending market against on-chain state before retry/alert. */
  fetchMarket(market: PublicKey): Promise<Pick<MarketAccount, "state"> | null>;
}

/** A frozen closing observation for one ticker, reused for every strike/retry that day (fix #4). */
export interface CloseObservation {
  priceAccount: string;
  publishTime: number;
}

export interface SettlementStatusEntry {
  market: string;
  ticker: Ticker;
  strike: string;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  overrideAvailableAt: string;
  settled: boolean;
  /** Fix #4: exposes the single closing observation this ticker settled against, once known. */
  closeObservation?: CloseObservation;
}

/** In-memory settlement status, keyed by market pubkey base58. Exported for `status.ts`. */
export const settlementStatus = new Map<string, SettlementStatusEntry>();

/** Test-only reset so suites don't leak state into each other. */
export function __resetSettlementStatus(): void {
  settlementStatus.clear();
}

type Sleep = (ms: number) => Promise<void>;
type Now = () => number;

export interface SettleJobDeps {
  chain: SettleChain;
  provider: PriceProvider;
  alertWebhookUrl?: string;
  alertFn?: (input: AlertInput, webhookUrl: string | undefined) => Promise<void>;
  now?: Now;
  sleep?: Sleep;
  retryIntervalMs?: number;
  alertWindowMs?: number;
}

export interface SettleJobOptions {
  day?: number;
  once?: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusEntry(record: MarketRecord, overrideDelaySecs: number): SettlementStatusEntry {
  const key = record.publicKey.toBase58();
  const existing = settlementStatus.get(key);
  if (existing) return existing;
  const entry: SettlementStatusEntry = {
    market: key,
    ticker: record.account.ticker,
    strike: record.account.strike.toString(),
    attempts: 0,
    overrideAvailableAt: new Date((record.account.closeTs + overrideDelaySecs) * 1000).toISOString(),
    settled: false,
  };
  settlementStatus.set(key, entry);
  return entry;
}

/** Re-fetches every still-pending market; one already `Settled` on chain is reconciled as success. */
async function reconcileSettled(
  chain: SettleChain,
  ticker: Ticker,
  pending: Map<string, MarketRecord>,
): Promise<void> {
  for (const [key, record] of Array.from(pending.entries())) {
    const fresh = await chain.fetchMarket(record.publicKey);
    if (fresh && fresh.state === "Settled") {
      const entry = settlementStatus.get(key)!;
      entry.settled = true;
      entry.lastError = undefined;
      entry.nextRetryAt = undefined;
      pending.delete(key);
      log({
        job: "settle",
        ticker,
        market: key,
        step: "settle_market",
        ok: true,
        error: "already settled on chain (reconciled)",
      });
    }
  }
}

async function settleTickerGroup(
  ticker: Ticker,
  markets: MarketRecord[],
  deps: Required<Pick<SettleJobDeps, "chain" | "provider" | "now" | "sleep" | "retryIntervalMs" | "alertWindowMs">> &
    Pick<SettleJobDeps, "alertWebhookUrl" | "alertFn">,
  overrideDelaySecs: number,
  once: boolean,
): Promise<void> {
  const pending = new Map<string, MarketRecord>(markets.map((m) => [m.publicKey.toBase58(), m]));
  for (const m of markets) statusEntry(m, overrideDelaySecs);

  // All strikes for one ticker on one trading day share the same close_ts.
  const closeTs = markets[0]?.account.closeTs ?? 0;

  const start = deps.now();
  let attemptNumber = 0;
  // Fix #4: cached once a post-close, fresh observation is obtained; never re-fetched after that.
  let closeObservation: { priceAccount: PublicKey; publishTime: number } | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Fix #17: reconcile against on-chain state before doing any work this round.
    await reconcileSettled(deps.chain, ticker, pending);
    if (pending.size === 0) return;

    // Fix #16: the deadline is checked *before* starting an attempt.
    const elapsed = deps.now() - start;
    if (!once && elapsed >= deps.alertWindowMs) {
      break; // fall through to the alert path below
    }

    attemptNumber += 1;
    const attemptAt = new Date(deps.now()).toISOString();
    let lastError: string | undefined;

    try {
      // Fix #4: publish (and cache) exactly once per ticker per day; every subsequent strike
      // and retry reuses the same observation rather than fetching a fresh live quote.
      if (!closeObservation) {
        const published = await deps.provider.publish(ticker);
        if (published.publishTime < closeTs) {
          // Pre-close observations are never used for settlement (fix #4): discard and retry.
          throw new Error(
            `${ticker} publish returned a pre-close observation (publishTime=${published.publishTime} ` +
              `< closeTs=${closeTs}); discarding`,
          );
        }
        closeObservation = published;
      }
      const { priceAccount, publishTime } = closeObservation;
      const closeObservationForStatus: CloseObservation = { priceAccount: priceAccount.toBase58(), publishTime };

      for (const [key, record] of Array.from(pending.entries())) {
        const entry = settlementStatus.get(key)!;
        entry.attempts += 1;
        entry.lastAttemptAt = attemptAt;
        entry.closeObservation = closeObservationForStatus;
        try {
          await deps.chain.settleMarket(record.publicKey, priceAccount);
          entry.settled = true;
          entry.lastError = undefined;
          entry.nextRetryAt = undefined;
          pending.delete(key);
          log({ job: "settle", ticker, market: key, step: "settle_market", ok: true });
        } catch (err) {
          if (isAlreadySettledError(err)) {
            entry.settled = true;
            entry.lastError = undefined;
            entry.nextRetryAt = undefined;
            pending.delete(key);
            log({ job: "settle", ticker, market: key, step: "settle_market", ok: true, error: "AlreadySettled" });
          } else {
            const message = (err as Error).message ?? String(err);
            entry.lastError = message;
            lastError = message;
            log({ job: "settle", ticker, market: key, step: "settle_market", ok: false, error: message });
          }
        }
      }
    } catch (err) {
      lastError = (err as Error).message ?? String(err);
      for (const key of pending.keys()) {
        const entry = settlementStatus.get(key)!;
        entry.attempts += 1;
        entry.lastAttemptAt = attemptAt;
        entry.lastError = lastError;
      }
      log({ job: "settle", ticker, step: "publish", ok: false, error: lastError });

      // Fix #4: Hermes 401/403/429 (auth/entitlement/rate-limit) are terminal for this
      // automatic attempt -- retrying every 30s for 15 minutes hammers a key that will
      // never become entitled by retrying. Alert once immediately (status + the
      // entitlement/pricing reminder) and stop retrying this ticker, instead of falling
      // into the normal retry window below. Other errors (RPC hiccups, etc.) keep it.
      if (err instanceof HermesError && (err.status === 401 || err.status === 403 || err.status === 429)) {
        const alertFn = deps.alertFn ?? defaultAlert;
        const anyRemaining = Array.from(pending.values())[0];
        const entry = settlementStatus.get(anyRemaining.publicKey.toBase58())!;
        await alertFn(
          {
            ticker,
            error: `Hermes returned HTTP ${err.status} (terminal, not retried): ${ENTITLEMENT_REMINDER}`,
            overrideAvailableAtEt: entry.overrideAvailableAt,
            market: entry.market,
          },
          deps.alertWebhookUrl,
        );
        for (const key of pending.keys()) settlementStatus.get(key)!.nextRetryAt = undefined;
        return;
      }
    }

    if (pending.size === 0) return;

    if (once) {
      // Fix #18: clear retry scheduling on every terminal path, including single-pass mode.
      for (const key of pending.keys()) settlementStatus.get(key)!.nextRetryAt = undefined;
      return;
    }

    // Fix #16: sleep only long enough to reach the next fixed scheduled timestamp, so a slow
    // attempt doesn't push every later attempt later too (no cadence drift).
    const nextAttemptAt = start + attemptNumber * deps.retryIntervalMs;
    const sleepMs = Math.max(0, nextAttemptAt - deps.now());
    const nextRetryAtIso = new Date(deps.now() + sleepMs).toISOString();
    for (const key of pending.keys()) {
      settlementStatus.get(key)!.nextRetryAt = nextRetryAtIso;
    }
    await deps.sleep(sleepMs);
  }

  // Alert path: the 15-minute window has elapsed. Reconcile once more (fix #17) before
  // actually alerting, in case the last pending markets settled via another caller in the
  // interim.
  await reconcileSettled(deps.chain, ticker, pending);
  if (pending.size === 0) return;

  const alertFn = deps.alertFn ?? defaultAlert;
  const anyRemaining = Array.from(pending.values())[0];
  const entry = settlementStatus.get(anyRemaining.publicKey.toBase58())!;
  await alertFn(
    {
      ticker,
      error: entry.lastError ?? "unknown error",
      overrideAvailableAtEt: entry.overrideAvailableAt,
      market: entry.market,
    },
    deps.alertWebhookUrl,
  );

  // Fix #18: clear retry scheduling on every terminal path, including the alert path.
  for (const key of pending.keys()) {
    settlementStatus.get(key)!.nextRetryAt = undefined;
  }
}

/**
 * Discovers `Config` and the due `Open` markets, retried every `retryIntervalMs` within
 * `alertWindowMs` of `start` (fix #15). Returns `null` if discovery never succeeds within the
 * window, in which case the caller alerts once and settles nothing this run.
 */
async function discoverWithRetry(
  deps: Required<Pick<SettleJobDeps, "chain" | "now" | "sleep" | "retryIntervalMs" | "alertWindowMs">>,
  tradingDay: number,
  start: number,
): Promise<{ config: { overrideDelaySecs: number }; openMarkets: MarketRecord[] } | null> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const config = await deps.chain.fetchConfig();
      const openMarkets = await deps.chain.fetchOpenMarkets(tradingDay);
      return { config, openMarkets };
    } catch {
      const elapsed = deps.now() - start;
      if (elapsed >= deps.alertWindowMs) return null;
      await deps.sleep(deps.retryIntervalMs);
    }
  }
}

/** Runs one pass (or, unless `once`, a full retry cycle) of the settle job. */
export async function runSettleJob(deps: SettleJobDeps, opts: SettleJobOptions = {}): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const retryIntervalMs = deps.retryIntervalMs ?? RETRY_INTERVAL_MS;
  const alertWindowMs = deps.alertWindowMs ?? ALERT_WINDOW_MS;
  const once = opts.once ?? false;

  const tradingDay = opts.day ?? tradingDayOf(Math.floor(now() / 1000));
  const start = now();

  let config: { overrideDelaySecs: number };
  let openMarkets: MarketRecord[];

  if (once) {
    // --once is a single pass end to end, including discovery: no retry loop here either.
    config = await deps.chain.fetchConfig();
    openMarkets = await deps.chain.fetchOpenMarkets(tradingDay);
  } else {
    // Fix #15: Config/market discovery failures are retried inside the same cadence/window as
    // settlement itself, rather than aborting the whole job immediately.
    const discovered = await discoverWithRetry({ chain: deps.chain, now, sleep, retryIntervalMs, alertWindowMs }, tradingDay, start);
    if (!discovered) {
      const alertFn = deps.alertFn ?? defaultAlert;
      await alertFn(
        {
          ticker: "(all)",
          error: `settle: Config/market discovery did not succeed within ${alertWindowMs / 60_000} minutes`,
          overrideAvailableAtEt: new Date().toISOString(),
        },
        deps.alertWebhookUrl,
      );
      return;
    }
    ({ config, openMarkets } = discovered);
  }

  const nowSeconds = Math.floor(now() / 1000);
  const dueMarkets = openMarkets.filter((m) => m.account.closeTs <= nowSeconds);

  const byTicker = new Map<Ticker, MarketRecord[]>();
  for (const m of dueMarkets) {
    const list = byTicker.get(m.account.ticker) ?? [];
    list.push(m);
    byTicker.set(m.account.ticker, list);
  }

  const resolvedDeps = {
    chain: deps.chain,
    provider: deps.provider,
    now,
    sleep,
    retryIntervalMs,
    alertWindowMs,
    alertWebhookUrl: deps.alertWebhookUrl,
    alertFn: deps.alertFn,
  };

  await Promise.all(
    Array.from(byTicker.entries()).map(([ticker, markets]) =>
      settleTickerGroup(ticker, markets, resolvedDeps, config.overrideDelaySecs, once),
    ),
  );
}
