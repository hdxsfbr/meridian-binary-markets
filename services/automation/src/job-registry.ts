/**
 * In-memory heartbeat registry (contracts/automation.md, `reconcile` job):
 * records the last completion time of each cron-scheduled job
 * (`morning`/`settle`/`extend`/`reclaim`) so `reconcile` can flag one that
 * hasn't run when the cron schedule in `index.ts` says it should have.
 *
 * Deliberately in-memory, not persisted: this is a liveness signal for the
 * single long-running `start` process, not a durable job-history store (that
 * is what the structured logs and `/events` are for). A worker restart
 * resets it -- `workerStartedAt` moves forward with it, so `reconcile`'s
 * "has not completed since the worker started" check is always relative to
 * *this* process's lifetime, not some persisted history. `index.ts` is the
 * only writer: it calls `recordJobCompletion` once a scheduled job's
 * `.catch`-wrapped promise resolves successfully, for every cron tick
 * (`morning`, `settle`, `reclaim`) and every `extend` tick, gated or not;
 * `reconcile` judges `extend` against its *effective* 09:35-15:45 ET window
 * rather than the bare cron expression (`HEARTBEAT_SCHEDULES` in
 * `jobs/reconcile.ts`).
 *
 * A one-off `job <name>` CLI invocation runs in its own short-lived process
 * and never shares this registry with a running `start` worker, so
 * `job reconcile` run that way reports on markets and the ladder normally but
 * has no heartbeat history to judge: it sees a worker that started a moment
 * ago, for which no scheduled run was yet due, and reports no heartbeat
 * findings at all -- by design (see jobs/reconcile.ts
 * and docs/risks-and-limitations.md's Observability paragraph). The
 * heartbeat check is only meaningful when `reconcile` runs inside the same
 * `start` process as the jobs it's checking, i.e. via its own cron tick.
 */

export type RegisteredJob = "morning" | "settle" | "extend" | "reclaim";

export interface JobRegistrySnapshot {
  /** Unix ms when this process (or the last `__resetJobRegistry` call) started. */
  workerStartedAt: number;
  /** Unix ms of each job's last successful completion, if any this process has seen. */
  lastCompletedAt: Partial<Record<RegisteredJob, number>>;
}

let workerStartedAt = Date.now();
let lastCompletedAt: Partial<Record<RegisteredJob, number>> = {};

/** Records `job` as having completed successfully at `at` (defaults to now). */
export function recordJobCompletion(job: RegisteredJob, at: number = Date.now()): void {
  lastCompletedAt[job] = at;
}

/** A read-only snapshot of the registry, safe for `reconcile`/`/status` to read and serialize. */
export function getJobRegistrySnapshot(): JobRegistrySnapshot {
  return { workerStartedAt, lastCompletedAt: { ...lastCompletedAt } };
}

/** Test-only reset so suites don't leak state into each other (same shape as `__resetSettlementStatus`). */
export function __resetJobRegistry(startedAt: number = Date.now()): void {
  workerStartedAt = startedAt;
  lastCompletedAt = {};
}
