# Contract: automation service jobs (PRD §5.3, FR-001…FR-004, FR-017, FR-032)

One Node process, `services/automation`, scheduled with `node-cron` in `America/New_York`. Trading
days are weekdays minus the holiday list parsed from the Pyth feed schedule (R9). All times ET.

| Job | Schedule | Steps | Failure handling |
|---|---|---|---|
| `morning` | 08:00 | for each enabled ticker: `provider.previousClose` → strike ladder → `create_market` per strike with `close_ts = 16:00:00 ET` and configured capacity | per-ticker try/catch; a failing ticker is logged and skipped, others proceed (FR-004); 3 retries with backoff per transaction. If a ticker's ladder still can't be completed after that (previous-close read failed, or any strike's `create_market`/`create_book` failed), one alert is sent for that ticker once every ticker has been attempted |
| `settle` | 16:00:30 | for each `Open` market with `close_ts ≤ now`: `provider.publish(ticker)` once per ticker, then `settle_market` per market | on any guard error or RPC failure, retry the ticker every 30 s until 16:15:30; then `alert(ticker, lastError)` and stop (FR-032). `AlreadySettled` counts as success |
| `reclaim` | 20:00 | for each `Settled` market older than 1 day with empty book and vault: `close_book`, `close_market` | best effort, logged |
| `publisher` (mock only) | every 60 s during 09:25–16:10 | `mock_write_price` for each ticker from Finnhub + Nasdaq | skip write if either source fails; log |
| `reconcile` | every 30 min | read-only audit, everything compared in micro units (`pairsMicro = pairs_outstanding * 1_000_000`): per market, one `getMultipleAccountsInfo` snapshot of `Market` + vault + both mints, then (a) `Open`: `vault >= pairsMicro` and both supplies `== pairsMicro`, (b) `Settled`: `vault >= winning supply`, surplus only flagged when above *both* supplies (unredeemed losing pairs explain the rest), neither supply above `pairsMicro`, (c) no `Open` market more than 15 min past `close_ts`, (d) on a trading day from 08:30 ET to midnight ET, every enabled ticker has a market for today's trading day, open **or** settled, (e) each cron job completed its most recent due run within 10 min (heartbeat; trading days only) | logs one JSON line per check; never sends a transaction. A failing check is re-snapshotted once and re-evaluated before it is recorded. A vault/supply/schedule/heartbeat breach is a `VIOLATION`, an unexplained vault surplus a `WARNING`, a read that failed a `CHECK_FAILED`; one failed read never aborts the pass. Exactly one alert summarizes everything found that pass (none when the pass is clean) |

## CLI entry points (same code, for scripts and the demo)

```
pnpm --filter automation run job morning   [--day YYYYMMDD]
pnpm --filter automation run job settle    [--day YYYYMMDD] [--once]
pnpm --filter automation run job publisher [--once]
pnpm --filter automation run job reclaim
pnpm --filter automation run job reconcile [--day YYYYMMDD] [--once]
```

`reconcile` is already a single read-only pass end to end -- there is no retry/alert-window loop
to opt out of, so `--once` is accepted (for symmetry with `settle --once`) but has no additional
effect. `--day` only affects the ladder check (d), the same `YYYYMMDD` override the other jobs
accept.

The heartbeat check (e) reads an in-memory registry that lives for the lifetime of the `start`
worker process (`services/automation/src/job-registry.ts`): `start` records each scheduled job's
last successful completion there. A manual `job <name>` CLI run is a *separate, short-lived
process* and never feeds that registry, so `job reconcile` run from the CLI reports on markets and
the ladder normally but has no heartbeat history to judge -- it sees a worker that started a moment
ago, for which no scheduled run was yet due, and reports no heartbeat findings. The heartbeat is
only meaningful from `reconcile`'s own cron tick inside the `start` process.

`--day` lets the demo create and settle a synthetic trading day on devnet without waiting for the
bell: `close_ts` is set to `now + N seconds` for the demo script, which is the only path where a
market's close is not 16:00 ET. The program does not care; FR-031 still holds relative to `close_ts`.

## Status endpoint

`GET http://<service>:$AUTOMATION_STATUS_PORT/status` (default 8787) returns
`{ updatedAt, markets: { [marketPubkey]: { ticker, strike, attempts, lastError, lastAttemptAt, nextRetryAt, overrideAvailableAt, settled } }, jobRegistry?, lastReconcile? }`
from the settlement job's in-memory map, plus (wired in by `index.ts`'s `start`) the job-heartbeat
registry and the most recent `reconcile` pass:
- `jobRegistry: { workerStartedAt, lastCompletedAt: { morning?, settle?, extend?, reclaim? } }`
  (Unix ms), from `services/automation/src/job-registry.ts`.
- `lastReconcile: { ranAt, tradingDay, counts: { checks, violations, warnings, checkFailed },
  findings: [{ severity, check, detail, market?, ticker?, job? }] }`, from
  `services/automation/src/jobs/reconcile.ts`. `severity` is `"VIOLATION" | "WARNING" |
  "CHECK_FAILED"`; `findings` holds only non-ok results, so a clean pass is an empty array with
  `counts.checks` recording how many checks ran.

Read-only, no auth, bound to the container network; the admin page reads it via
`NEXT_PUBLIC_AUTOMATION_STATUS_URL` and shows "Status unavailable" if it cannot be reached. It is
the only way the admin page learns *why* a market is unsettled, or what `reconcile` last found.

## Alert payload

`POST $ALERT_WEBHOOK_URL` with `{"text": "Meridian: <ticker> unsettled after 15 min — <error>. Override available at <close_ts + delay> ET."}`.
Also written to stderr at `error` level. No alert is sent for a successful settle.

The morning job reuses the same `alert` module and `alertWebhookUrl`/`alertFn` dependency shape:
one alert per ticker whose ladder could not be completed, naming the ticker, trading day, which
strikes failed, and the last error, with a morning-specific summary line in place of settle's
"unsettled after 15 min" text (and no override timestamp, which only applies to settle).

`reconcile` also reuses the same module: if a pass produced any finding at all (violation, warning
or failed check), exactly one alert is sent naming `ticker: "(all)"`, a `summary` counting
violations/warnings/failed checks, and an `error` that concatenates every finding's
`[SEVERITY] check (ticker) job=<job> market=<pubkey>: detail` line. A throwing/rejecting `alertFn`
is caught and logged, never allowed to fail the job (same guarantee `settle`/`morning` give).

## Logging

JSON lines to stdout: `{ts, job, ticker, market, step, ok, error?, sig?}`. The History page does not
read these; they are for the operator and the demo video.
