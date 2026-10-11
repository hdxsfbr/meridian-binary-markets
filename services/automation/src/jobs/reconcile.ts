/**
 * `reconcile` job (contracts/automation.md): a read-only audit pass over
 * on-chain state and the worker's own operational liveness. Unlike every
 * other job here it never sends a transaction.
 *
 * Everything is compared in *micro* units (USDC and the Yes/No tokens all
 * have 6 decimals, so one contract is `1_000_000` base units, and
 * `pairs_outstanding` -- a count of whole pairs -- is scaled to
 * `pairsMicro = pairs_outstanding * 1_000_000` before it is compared with a
 * vault balance or a mint supply). The on-chain invariants being audited are
 * the ones the program itself enforces:
 *
 *   - `mint_pair`/`redeem_pair` keep an `Open` market at
 *     `vault.amount >= pairs_outstanding * 1_000_000`, with both mint
 *     supplies exactly equal to it (every pair minted mints one of each
 *     side; `redeem_pair` burns one of each and decrements the counter).
 *   - `redeem_winning` burns winning-side tokens and pays `1_000_000` each
 *     but deliberately does *not* touch `pairs_outstanding`, so on a
 *     `Settled` market the live invariant becomes
 *     `vault.amount >= winning_mint.supply` and `pairs_outstanding` is only
 *     an upper bound on either supply. A settled market whose winners have
 *     partly redeemed is therefore perfectly healthy with a vault far below
 *     `pairsMicro` -- this job must not flag it.
 *
 * Five check families, each logging one JSON line per individual check:
 *
 *   1. Open-market backing: vault deficit vs `pairsMicro` is a violation, a
 *      surplus is a warning, and either Yes/No supply differing from
 *      `pairsMicro` is a violation.
 *   2. Settled-market backing: vault deficit vs the winning supply is a
 *      violation; a surplus is only a warning when it is *not* explained by
 *      pairs the losing side has not redeemed yet; either supply above
 *      `pairsMicro` is a violation.
 *   3. Overdue settlement: an `Open` market more than 15 minutes past
 *      `close_ts` -- the same window `settle` itself gives up and alerts
 *      after (FR-032), read from the other side.
 *   4. Today's ladder: on a trading day from 08:30 ET until midnight ET,
 *      every enabled ticker in `Config` has at least one market for today's
 *      trading day -- open *or* settled, so the check does not start failing
 *      every evening once the 16:00 settle run has closed the ladder out.
 *   5. Heartbeats: each cron-scheduled job completed its most recent
 *      scheduled run (see `HEARTBEAT_SCHEDULES`, which mirrors `index.ts`'s
 *      cron table) within a 10-minute grace period. In-memory and
 *      process-scoped: see `job-registry.ts`.
 *
 * Pass rules, all of them consequences of "an audit must not cry wolf":
 *   - Per market, the `Market`, vault and both mints are read in one
 *     `getMultipleAccountsInfo` call (`chain.ts`'s `fetchMarketSnapshot`) so
 *     the numbers being compared come from a single slot, and the `Market`
 *     is re-decoded from that snapshot rather than reused from the scan
 *     that discovered it.
 *   - If any check on a market fails, that market is re-snapshotted once and
 *     re-evaluated; only the second verdict is recorded. A violation that
 *     disappears on the second look was a read straddling a transaction,
 *     not a broken market.
 *   - Any read failure is caught per market (or per check) and recorded as a
 *     `CHECK_FAILED` finding; the pass always continues through every other
 *     market and check.
 *   - Exactly one alert is sent at the end if anything at all was found,
 *     never one per check, and never when the pass is clean. A throwing
 *     `alertFn` is logged and never fails the job.
 */

import type { PublicKey } from "@solana/web3.js";
import type { Ticker } from "@meridian/sdk";
import { DateTime } from "luxon";
import type { MarketRecord, MarketSnapshot } from "../chain.js";
import { ET_ZONE, isTradingDay, staticHolidaysFor, tradingDayOf } from "../calendar.js";
import { log } from "../log.js";
import { alert as defaultAlert, type AlertInput } from "../alert.js";
import { getJobRegistrySnapshot, type JobRegistrySnapshot, type RegisteredJob } from "../job-registry.js";

/** Base units in one contract: USDC and the Yes/No tokens all have 6 decimals. */
export const MICRO_PER_CONTRACT = 1_000_000n;

/** `settle` alerts at 15 minutes past `close_ts` (FR-032); `reconcile` audits the same window. */
export const SETTLEMENT_OVERDUE_SECONDS = 15 * 60;

/** Grace period a scheduled job gets past its due time before its heartbeat counts as missed. */
export const HEARTBEAT_GRACE_MS = 10 * 60_000;

/** 08:30 ET: the morning ladder (08:00 ET) has had half an hour to finish by then. */
const LADDER_CHECK_HOUR = 8;
const LADDER_CHECK_MINUTE = 30;

export type ReconcileSeverity = "VIOLATION" | "WARNING" | "CHECK_FAILED";

export interface ReconcileFinding {
  severity: ReconcileSeverity;
  /** The check that produced it, e.g. `"open_backing"`, `"heartbeat"`. */
  check: string;
  detail: string;
  market?: string;
  ticker?: string;
  job?: string;
}

export interface ReconcileCounts {
  checks: number;
  violations: number;
  warnings: number;
  checkFailed: number;
}

export interface ReconcileReport {
  ranAt: string;
  tradingDay: number;
  counts: ReconcileCounts;
  /** Only non-ok results: a clean pass has an empty array. */
  findings: ReconcileFinding[];
}

/** In-memory last-reconcile report, exported for `/status` (same shape as `settlementStatus`). */
export let lastReconcile: ReconcileReport | undefined;

/** Test-only reset so suites don't leak state into each other. */
export function __resetLastReconcile(): void {
  lastReconcile = undefined;
}

export interface ReconcileChain {
  fetchOpenMarkets(): Promise<MarketRecord[]>;
  fetchSettledMarkets(): Promise<MarketRecord[]>;
  fetchConfig(): Promise<{ tickers: Array<{ symbol: Ticker; enabled: boolean }> }>;
  /** One consistent snapshot of a market's `Market`/vault/Yes/No accounts; `null` if closed. */
  fetchMarketSnapshot(market: PublicKey): Promise<MarketSnapshot | null>;
}

export interface ReconcileJobDeps {
  chain: ReconcileChain;
  alertWebhookUrl?: string;
  alertFn?: (input: AlertInput, webhookUrl: string | undefined) => Promise<void>;
  now?: () => number;
  /** Defaults to the real worker registry (`job-registry.ts`); overridable for tests. */
  registry?: () => JobRegistrySnapshot;
}

export interface ReconcileJobOptions {
  /** `YYYYMMDD` override; defaults to today (ET). Only affects the ladder check (4). */
  day?: number;
}

/** The static-fallback NYSE holiday set for `tradingDay`'s year (same fallback `morning.ts` uses). */
function holidaysForYear(tradingDay: number): Set<string> {
  const year = Number(String(tradingDay).slice(0, 4));
  try {
    return staticHolidaysFor(year);
  } catch {
    // Unsupported year in the static table: fail open as "no known holidays" rather than crash
    // the audit -- isTradingDay then falls back to a plain weekday check, same as morning.ts.
    return new Set();
  }
}

/** One check's verdict: the check's name plus every finding it produced (empty = ok). */
interface CheckOutcome {
  check: string;
  findings: ReconcileFinding[];
}

function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

// ---------------------------------------------------------------------------
// Checks 1-3: per-market, evaluated against one consistent snapshot.
// ---------------------------------------------------------------------------

/**
 * Checks 1-3 for one market, as a pure function of a single snapshot: the
 * caller is responsible for re-snapshotting and re-running this before it
 * believes any finding.
 */
export function evaluateMarketSnapshot(snapshot: MarketSnapshot, nowSeconds: number): CheckOutcome[] {
  const { account, vaultAmount, yesSupply, noSupply } = snapshot;
  const market = snapshot.publicKey.toBase58();
  const ticker = account.ticker;
  const pairsMicro = account.pairsOutstanding * MICRO_PER_CONTRACT;

  const finding = (severity: ReconcileSeverity, check: string, detail: string): ReconcileFinding => ({
    severity,
    check,
    detail,
    market,
    ticker,
  });

  const outcomes: CheckOutcome[] = [];

  if (account.state === "Open") {
    const backing: ReconcileFinding[] = [];
    if (vaultAmount < pairsMicro) {
      backing.push(
        finding(
          "VIOLATION",
          "open_backing",
          `vault deficit: vault=${vaultAmount} < pairsMicro=${pairsMicro} ` +
            `(pairsOutstanding=${account.pairsOutstanding})`,
        ),
      );
    } else if (vaultAmount > pairsMicro) {
      backing.push(
        finding(
          "WARNING",
          "open_backing",
          `vault surplus: vault=${vaultAmount} > pairsMicro=${pairsMicro} ` +
            `(pairsOutstanding=${account.pairsOutstanding})`,
        ),
      );
    }
    outcomes.push({ check: "open_backing", findings: backing });

    const supply: ReconcileFinding[] = [];
    if (yesSupply !== pairsMicro || noSupply !== pairsMicro) {
      supply.push(
        finding(
          "VIOLATION",
          "open_supply",
          `supply mismatch: yesSupply=${yesSupply} noSupply=${noSupply} pairsMicro=${pairsMicro}`,
        ),
      );
    }
    outcomes.push({ check: "open_supply", findings: supply });

    const overdue: ReconcileFinding[] = [];
    if (account.closeTs + SETTLEMENT_OVERDUE_SECONDS < nowSeconds) {
      const minutes = Math.floor((nowSeconds - account.closeTs) / 60);
      overdue.push(
        finding(
          "VIOLATION",
          "settlement_overdue",
          `still Open ${minutes} min past close (closeTs=${new Date(account.closeTs * 1000).toISOString()}, ` +
            `window=${SETTLEMENT_OVERDUE_SECONDS / 60} min)`,
        ),
      );
    }
    outcomes.push({ check: "settlement_overdue", findings: overdue });

    return outcomes;
  }

  // Settled. `pairs_outstanding` is frozen at settlement and `redeem_winning` does not touch it,
  // so it is only an upper bound here; the live backing requirement is the winning supply.
  const backing: ReconcileFinding[] = [];
  if (account.outcome === "Unset") {
    // The program never settles without an outcome (`settle_market` always writes Yes or No), so
    // there is no winning side to measure the vault against: report it rather than guess.
    backing.push(
      finding("VIOLATION", "settled_backing", `settled market has outcome Unset; cannot determine the winning side`),
    );
    outcomes.push({ check: "settled_backing", findings: backing });
  } else {
    const winningSupply = account.outcome === "Yes" ? yesSupply : noSupply;
    const losingSupply = account.outcome === "Yes" ? noSupply : yesSupply;
    if (vaultAmount < winningSupply) {
      backing.push(
        finding(
          "VIOLATION",
          "settled_backing",
          `vault deficit: vault=${vaultAmount} < winningSupply=${winningSupply} (outcome=${account.outcome})`,
        ),
      );
    } else if (vaultAmount > winningSupply) {
      // After settlement the vault is backed by the winning supply alone: `redeem_winning` burns
      // one winning token per 1_000_000 paid, and `redeem_pair` burns one of each side per
      // 1_000_000 paid, so both paths move the vault and the winning supply together and the
      // losing supply never explains collateral. Anything above the winning supply is unsolicited.
      backing.push(
        finding(
          "WARNING",
          "settled_backing",
          `vault surplus: vault=${vaultAmount} > winningSupply=${winningSupply} (losingSupply=` +
            `${losingSupply}, outcome=${account.outcome})`,
        ),
      );
    }
    outcomes.push({ check: "settled_backing", findings: backing });
  }

  const supply: ReconcileFinding[] = [];
  if (yesSupply > pairsMicro || noSupply > pairsMicro) {
    supply.push(
      finding(
        "VIOLATION",
        "settled_supply",
        `supply above pairs: yesSupply=${yesSupply} noSupply=${noSupply} pairsMicro=${pairsMicro}`,
      ),
    );
  }
  outcomes.push({ check: "settled_supply", findings: supply });

  return outcomes;
}

// ---------------------------------------------------------------------------
// Check 4: today's ladder.
// ---------------------------------------------------------------------------

function pastLadderCheckTime(nowMs: number): boolean {
  const nowEt = DateTime.fromMillis(nowMs, { zone: ET_ZONE });
  return (
    nowEt.hour > LADDER_CHECK_HOUR || (nowEt.hour === LADDER_CHECK_HOUR && nowEt.minute >= LADDER_CHECK_MINUTE)
  );
}

// ---------------------------------------------------------------------------
// Check 5: heartbeats.
// ---------------------------------------------------------------------------

type HeartbeatSchedule =
  | { kind: "daily"; hour: number; minute: number; second?: number }
  | { kind: "window"; startHour: number; startMinute: number; endHour: number; endMinute: number; everyMinutes: number };

/**
 * Mirrors `index.ts`'s cron table. `extend` is expressed as its *effective*
 * schedule (every 5 minutes inside the 09:35-15:45 ET window `runExtendTick`
 * gates itself to), not as the bare every-5-minutes cron expression, so a tick that is
 * correctly doing nothing outside the window is never mistaken for a missed
 * run. All four only ever run on trading days.
 */
const HEARTBEAT_SCHEDULES: Record<RegisteredJob, HeartbeatSchedule> = {
  morning: { kind: "daily", hour: 8, minute: 0 },
  settle: { kind: "daily", hour: 16, minute: 0, second: 30 },
  reclaim: { kind: "daily", hour: 20, minute: 0 },
  extend: { kind: "window", startHour: 9, startMinute: 35, endHour: 15, endMinute: 45, everyMinutes: 5 },
};

/**
 * The most recent scheduled run of `schedule` that is already past its grace
 * period at `nowMs`, or `null` if there is no such run today. "Past its grace
 * period" is how the spec's "the last completion is older than that due time
 * + 10 min" is implemented: the grace is time the job is *allowed* to still
 * be running in, so nothing is judged until it has elapsed, and then the
 * question is simply whether a completion has been recorded at or after the
 * due time itself.
 */
function lastDueRun(schedule: HeartbeatSchedule, nowMs: number): DateTime | null {
  const nowEt = DateTime.fromMillis(nowMs, { zone: ET_ZONE });
  const judgeableUntil = nowEt.minus({ milliseconds: HEARTBEAT_GRACE_MS });

  if (schedule.kind === "daily") {
    const due = nowEt.set({ hour: schedule.hour, minute: schedule.minute, second: schedule.second ?? 0, millisecond: 0 });
    return due <= judgeableUntil ? due : null;
  }

  const start = nowEt.set({ hour: schedule.startHour, minute: schedule.startMinute, second: 0, millisecond: 0 });
  const end = nowEt.set({ hour: schedule.endHour, minute: schedule.endMinute, second: 0, millisecond: 0 });
  const ceiling = judgeableUntil < end ? judgeableUntil : end;
  if (ceiling < start) return null;
  const elapsedMinutes = Math.floor(ceiling.diff(start, "minutes").minutes);
  const ticks = Math.floor(elapsedMinutes / schedule.everyMinutes);
  return start.plus({ minutes: ticks * schedule.everyMinutes });
}

function checkHeartbeat(
  job: RegisteredJob,
  schedule: HeartbeatSchedule,
  nowMs: number,
  registry: JobRegistrySnapshot,
): CheckOutcome {
  const due = lastDueRun(schedule, nowMs);
  const findings: ReconcileFinding[] = [];

  // Nothing due yet today (or not far enough past due to judge), or the worker started after the
  // last due run: either way this process was never given the chance to run it.
  if (due === null || due.toMillis() < registry.workerStartedAt) {
    return { check: "heartbeat", findings };
  }

  const lastCompletedAt = registry.lastCompletedAt[job];
  if (lastCompletedAt === undefined || lastCompletedAt < due.toMillis()) {
    findings.push({
      severity: "VIOLATION",
      check: "heartbeat",
      job,
      detail:
        `job did not run: ${job} was due ${due.toISO()} and has not completed since ` +
        `(last completion ${lastCompletedAt === undefined ? "never, this process" : new Date(lastCompletedAt).toISOString()}, ` +
        `grace ${HEARTBEAT_GRACE_MS / 60_000} min)`,
    });
  }
  return { check: "heartbeat", findings };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/** Runs one pass of the reconcile job: every check family, then at most one alert. */
export async function runReconcileJob(deps: ReconcileJobDeps, opts: ReconcileJobOptions = {}): Promise<ReconcileReport> {
  const now = deps.now ?? (() => Date.now());
  const registry = deps.registry ?? getJobRegistrySnapshot;
  const nowMs = now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const tradingDay = opts.day ?? tradingDayOf(nowSeconds);
  const onTradingDay = isTradingDay(tradingDay, holidaysForYear(tradingDay));

  const findings: ReconcileFinding[] = [];
  let checks = 0;

  /** Records one check's verdict: one log line, plus its findings (if any) in the report. */
  const record = (outcome: CheckOutcome, scope: { market?: string; ticker?: string } = {}): void => {
    checks += 1;
    const failed = outcome.findings.length > 0;
    log({
      job: "reconcile",
      step: outcome.check,
      market: scope.market,
      ticker: scope.ticker,
      ok: !failed,
      error: failed ? outcome.findings.map((f) => `[${f.severity}] ${f.detail}`).join("; ") : undefined,
    });
    findings.push(...outcome.findings);
  };

  /** Records a read/decode failure as its own `CHECK_FAILED` check. */
  const recordFailure = (check: string, detail: string, scope: { market?: string; ticker?: string } = {}): void => {
    record({ check, findings: [{ severity: "CHECK_FAILED", check, detail, ...scope }] }, scope);
  };

  // --- Scan. Either scan failing is a CHECK_FAILED, not a reason to abort the pass.
  let openMarkets: MarketRecord[] = [];
  let settledMarkets: MarketRecord[] = [];
  let scanOk = true;
  try {
    openMarkets = await deps.chain.fetchOpenMarkets();
  } catch (err) {
    scanOk = false;
    recordFailure("scan_open", `fetchOpenMarkets failed: ${errorMessage(err)}`);
  }
  try {
    settledMarkets = await deps.chain.fetchSettledMarkets();
  } catch (err) {
    scanOk = false;
    recordFailure("scan_settled", `fetchSettledMarkets failed: ${errorMessage(err)}`);
  }

  // --- Checks 1-3, per market, each against its own one-call snapshot.
  for (const scanned of [...openMarkets, ...settledMarkets]) {
    const market = scanned.publicKey.toBase58();
    const ticker = scanned.account.ticker;
    const scope = { market, ticker };
    try {
      // eslint-disable-next-line no-await-in-loop
      let snapshot = await deps.chain.fetchMarketSnapshot(scanned.publicKey);
      if (snapshot === null) {
        // Closed between the scan and now: nothing left to audit.
        record({ check: "snapshot", findings: [] }, scope);
        continue;
      }
      let outcomes = evaluateMarketSnapshot(snapshot, nowSeconds);
      if (outcomes.some((o) => o.findings.length > 0)) {
        // Re-snapshot once: a deficit or mismatch seen across a transaction boundary must not be
        // reported on the strength of a single read.
        // eslint-disable-next-line no-await-in-loop
        const second = await deps.chain.fetchMarketSnapshot(scanned.publicKey);
        if (second === null) {
          record({ check: "snapshot", findings: [] }, scope);
          continue;
        }
        snapshot = second;
        outcomes = evaluateMarketSnapshot(second, nowSeconds);
      }
      for (const outcome of outcomes) record(outcome, scope);
    } catch (err) {
      recordFailure("market_snapshot", `snapshot of market ${market} failed: ${errorMessage(err)}`, scope);
    }
  }

  // --- Check 4: today's ladder.
  if (!onTradingDay || !pastLadderCheckTime(nowMs)) {
    // Not applicable: nothing to assert before 08:30 ET, or on a weekend/holiday.
  } else if (!scanOk) {
    recordFailure("ladder", `market scan failed this pass; today's ladder cannot be audited`);
  } else {
    try {
      const config = await deps.chain.fetchConfig();
      const present = new Set(
        [...openMarkets, ...settledMarkets]
          .filter((m) => m.account.tradingDay === tradingDay)
          .map((m) => m.account.ticker),
      );
      for (const info of config.tickers.filter((t) => t.enabled)) {
        const ladderFindings: ReconcileFinding[] = present.has(info.symbol)
          ? []
          : [
              {
                severity: "VIOLATION",
                check: "ladder",
                ticker: info.symbol,
                detail: `no market for trading day ${tradingDay} on ${info.symbol} (open or settled)`,
              },
            ];
        record({ check: "ladder", findings: ladderFindings }, { ticker: info.symbol });
      }
    } catch (err) {
      recordFailure("ladder", `fetchConfig failed: ${errorMessage(err)}`);
    }
  }

  // --- Check 5: heartbeats. Nothing is scheduled on a weekend or holiday.
  if (onTradingDay) {
    const snapshot = registry();
    for (const job of Object.keys(HEARTBEAT_SCHEDULES) as RegisteredJob[]) {
      record(checkHeartbeat(job, HEARTBEAT_SCHEDULES[job], nowMs, snapshot));
    }
  }

  const counts: ReconcileCounts = {
    checks,
    violations: findings.filter((f) => f.severity === "VIOLATION").length,
    warnings: findings.filter((f) => f.severity === "WARNING").length,
    checkFailed: findings.filter((f) => f.severity === "CHECK_FAILED").length,
  };

  if (findings.length > 0) {
    const alertFn = deps.alertFn ?? defaultAlert;
    const lines = findings.map(
      (f) =>
        `[${f.severity}] ${f.check}` +
        `${f.ticker ? ` (${f.ticker})` : ""}${f.job ? ` job=${f.job}` : ""}${f.market ? ` market=${f.market}` : ""}: ${f.detail}`,
    );
    try {
      await alertFn(
        {
          job: "reconcile",
          ticker: "(all)",
          summary: `reconcile found ${counts.violations} violation(s), ${counts.warnings} warning(s), ${counts.checkFailed} failed check(s)`,
          error: lines.join(" | "),
        },
        deps.alertWebhookUrl,
      );
    } catch (err) {
      // A throwing alertFn must never fail the job -- same guarantee settle/morning give.
      log({ job: "reconcile", step: "alert", ok: false, error: `alertFn threw: ${errorMessage(err)}` });
    }
  }

  log({
    job: "reconcile",
    step: "summary",
    ok: findings.length === 0,
    checks: counts.checks,
    violations: counts.violations,
    warnings: counts.warnings,
    checkFailed: counts.checkFailed,
  });

  const report: ReconcileReport = { ranAt: new Date(nowMs).toISOString(), tradingDay, counts, findings };
  lastReconcile = report;
  return report;
}
