# Contract: automation service jobs (PRD §5.3, FR-001…FR-004, FR-017, FR-032)

One Node process, `services/automation`, scheduled with `node-cron` in `America/New_York`. Trading
days are weekdays minus the holiday list parsed from the Pyth feed schedule (R9). All times ET.

| Job | Schedule | Steps | Failure handling |
|---|---|---|---|
| `morning` | 08:00 | for each enabled ticker: `provider.previousClose` → strike ladder → `create_market` per strike with `close_ts = 16:00:00 ET` and configured capacity | per-ticker try/catch; a failing ticker is logged and skipped, others proceed (FR-004); 3 retries with backoff per transaction. If a ticker's ladder still can't be completed after that (previous-close read failed, or any strike's `create_market`/`create_book` failed), one alert is sent for that ticker once every ticker has been attempted |
| `settle` | 16:00:30 | for each `Open` market with `close_ts ≤ now`: `provider.publish(ticker)` once per ticker, then `settle_market` per market | on any guard error or RPC failure, retry the ticker every 30 s until 16:15:30; then `alert(ticker, lastError)` and stop (FR-032). `AlreadySettled` counts as success |
| `reclaim` | 20:00 | for each `Settled` market older than 1 day with empty book and vault: `close_book`, `close_market` | best effort, logged |
| `publisher` (mock only) | every 60 s during 09:25–16:10 | `mock_write_price` for each ticker from Finnhub + Nasdaq | skip write if either source fails; log |

## CLI entry points (same code, for scripts and the demo)

```
pnpm --filter automation run job morning   [--day YYYYMMDD]
pnpm --filter automation run job settle    [--day YYYYMMDD] [--once]
pnpm --filter automation run job publisher [--once]
pnpm --filter automation run job reclaim
```

`--day` lets the demo create and settle a synthetic trading day on devnet without waiting for the
bell: `close_ts` is set to `now + N seconds` for the demo script, which is the only path where a
market's close is not 16:00 ET. The program does not care; FR-031 still holds relative to `close_ts`.

## Status endpoint

`GET http://<service>:$AUTOMATION_STATUS_PORT/status` (default 8787) returns
`{ updatedAt, markets: { [marketPubkey]: { ticker, strike, attempts, lastError, lastAttemptAt, nextRetryAt, overrideAvailableAt, settled } } }`
from the settlement job's in-memory map. Read-only, no auth, bound to the container network; the
admin page reads it via `NEXT_PUBLIC_AUTOMATION_STATUS_URL` and shows "Status unavailable" if it
cannot be reached. It is the only way the admin page learns *why* a market is unsettled.

## Alert payload

`POST $ALERT_WEBHOOK_URL` with `{"text": "Meridian: <ticker> unsettled after 15 min — <error>. Override available at <close_ts + delay> ET."}`.
Also written to stderr at `error` level. No alert is sent for a successful settle.

The morning job reuses the same `alert` module and `alertWebhookUrl`/`alertFn` dependency shape:
one alert per ticker whose ladder could not be completed, naming the ticker, trading day, which
strikes failed, and the last error, with a morning-specific summary line in place of settle's
"unsettled after 15 min" text (and no override timestamp, which only applies to settle).

## Logging

JSON lines to stdout: `{ts, job, ticker, market, step, ok, error?, sig?}`. The History page does not
read these; they are for the operator and the demo video.
