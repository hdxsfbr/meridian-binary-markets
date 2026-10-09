# Key metrics

> Every number below is either read straight from the repo or produced by a command run inside
> the dev container (`docker exec -w /work meridian-web-devnet-e2e sh -c '...'`), on 2026-10-09.
> Where a number could not be verified that way, it says so next to the number instead of
> guessing.

## A. Impact metrics evidence

Targets are the brief's, from `docs/PRD.md` §2. Evidence is what has actually happened on
devnet, from `docs/deployment.md` §2.

| Dimension | Target (PRD §2) | Evidence |
| --- | --- | --- |
| Correctness | 100% of settlements pay the correct side; the $1.00 invariant is never violated | No incorrect settlement recorded on devnet to date (two Pyth-settled days, below). Enforced structurally by `mint_pair`/`redeem_pair` always moving equal Yes/No quantities — see `ARCHITECTURE.md` §3. |
| Liveness | Markets created before market open and settled within 10 minutes of close, every trading day | 2026-10-08: 46 markets settled 16:00:40-16:00:52 ET, one attempt. 2026-10-09: 47 markets settled 16:04:49-16:04:54 ET, on the ninth retry attempt (devnet confirmations exceeded the worker's 30 s limit on the first eight) — still inside the 10-minute target. |
| Operability | Full lifecycle demo reproducible on testnet: create -> mint -> trade -> settle -> redeem | Reproduced via `scripts/lifecycle.ts` on devnet (`docs/deployment.md` §1.4, §2: first full lifecycle on trading day 20261011) and via the automation service's own unattended runs on 2026-10-08 and 2026-10-09. |
| Documentation | Clear rationale for all architecture and chain decisions; trade-offs explained | `DECISIONS.md` (27 numbered decisions, each with a trade-off), `ARCHITECTURE.md`, `docs/risks-and-limitations.md`, `SCALING.md`. |

**How to refresh:** re-read `docs/deployment.md` §2's "Recorded addresses" table after any new
settlement day; it is updated by hand after each live run.

## B. Test coverage

Counts below are from running each suite inside the dev container today
(`docker exec -w /work meridian-web-devnet-e2e sh -c '<command>'`).

| Suite | Command | Result |
| --- | --- | --- |
| Rust program (`cargo test`, 15 test binaries) | `cargo test -p meridian --tests` | **270 passed, 0 failed** (sum across 15 binaries: 81, 10, 31, 10, 14, 14, 1, 18, 22, 3, 8, 4, 14, 9, 31). Cargo is available and runnable in this container — this run superseded `README.md`'s recorded "261 Rust program tests", which is stale as of today's run. |
| SDK | `pnpm --filter @meridian/sdk run test` | **116 passed** (8 files) |
| Scripts | `pnpm --filter @meridian/scripts run test` | **62 passed** (7 files) |
| Automation | `pnpm --filter @meridian/automation test` | **161 passed, 1 skipped** (17 files) |
| Web (Vitest) | `pnpm --filter @meridian/web test` | **260 passed** (16 files) |
| Web (Playwright, browser) | — | 3 spec files under `web/e2e/`: `admin.spec.ts`, `portfolio.spec.ts`, `trade.spec.ts` (not executed this pass — these need a live local validator; counted by listing the directory, not run) |

**How to refresh:** re-run each command above; for Playwright, `make test-web`.

## C. Program metrics

| Metric | Value | Source |
| --- | --- | --- |
| Instruction files | 16, under `programs/meridian/src/instructions/` | `ls programs/meridian/src/instructions/` |
| Program `pub fn`s (`#[program] mod meridian`) | 20 | `grep -n "pub fn" programs/meridian/src/lib.rs` |
| Compiled program binary, local build today | 613,488 bytes (`target/deploy/meridian.so`, built Oct 8 16:15 inside this container) | `ls -la target/deploy/meridian.so` in the container |
| Deployed program-data account (devnet) | 623,328 bytes, 3.167 SOL rent | `docs/deployment.md` §2 — not independently re-verified this pass since it describes a specific past deploy, not something a fresh build reproduces byte-for-byte |
| `Config` account | 539 bytes incl. 8-byte discriminator, seed `["config"]` | Carried over from the verified facts gathered earlier the same day; not independently re-derived this pass (would need an Anchor IDL build) |
| `Market` account | 196 bytes, seed `["market", ticker, trading_day u32 LE, strike u64 LE]` | Confirmed live via `CLUSTER=devnet pnpm --filter @meridian/scripts run rent-estimate` inside the container (prints 196 bytes) |
| `Book` account | `8 + 120 + 2*capacity*64` bytes: 2,176 at capacity 16, 16,512 at capacity 128 | `programs/meridian/src/state/book.rs`'s `book_space()` function and its own unit tests `book_space_for_demo_scale_capacity_16`/`_128`; confirmed live via `rent-estimate` (2,176 / 16,512 bytes) |
| Oracle guard order | `OracleBadPrice` -> `OracleStale` (300 s) -> `OracleTooOld` (60 s before close) -> `OracleLowConfidence` (25 bps) | `grep -n "OracleBadPrice\|OracleStale\|OracleTooOld\|OracleLowConfidence" programs/meridian/src/oracle/mod.rs` — confirmed this exact order in source |
| Override delay floor | 3,600 s (`MIN_OVERRIDE_DELAY_SECS`) | `programs/meridian/src/state/config.rs` |

**How to refresh:** `grep -c "pub fn" programs/meridian/src/lib.rs` (inside the `#[program]`
module) for the instruction count; `CLUSTER=devnet pnpm --filter @meridian/scripts run
rent-estimate` inside the container for live account/rent figures; `ls -la target/deploy/*.so`
after a fresh `anchor build` for the current binary size.

## D. Operational metrics

| Metric | Value | Source |
| --- | --- | --- |
| Morning job | `0 8 * * 1-5` (08:00 ET, weekdays) | `services/automation/src/index.ts` |
| Publisher job (mock provider only) | `* * * * *`, gated 09:25-16:10 ET | `services/automation/src/index.ts` |
| Extend job | `*/5 * * * 1-5`, gated 09:35-15:45 ET, capped at 2 added strikes/ticker/day | `services/automation/src/jobs/extend.ts`; `DECISIONS.md` §27 |
| Settle job | `30 0 16 * * 1-5` (16:00:30 ET) | `services/automation/src/index.ts` |
| Reclaim job | `0 20 * * 1-5` (20:00 ET) | `services/automation/src/index.ts` |
| Settle retry window | Every 30 s for 15 minutes, then alert via `ALERT_WEBHOOK_URL` | `services/automation/src/jobs/settle.ts` |
| Settle duration, 2026-10-08 | 46 markets, 16:00:40-16:00:52 ET, one attempt | `docs/deployment.md` §2 |
| Settle duration, 2026-10-09 | 47 markets, 16:04:49-16:04:54 ET, ninth attempt (first eight exceeded the worker's 30 s confirmation limit) | `docs/deployment.md` §2 |
| Tickers (devnet, since 2026-10-08) | 7 — AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA | `docs/deployment.md` §2 (Config PDA row) |
| Strikes per ticker | 5-7, ladder step $10 | `SCALING.md`, `docs/deployment.md` §1.4 |
| Markets per day (default 7-ticker ladder) | About 45-47 (46 on 2026-10-08, 47 on 2026-10-09) | `docs/deployment.md` §2 |
| Book capacity | 16 orders/side (demo scale, `DEMO_SCALE=1`, Railway default); 128 orders/side (production constant, `DEMO_SCALE=0`) | `docs/deployment.md` §1.1, §1.3, §6 |
| Demo wallet funding floors | User A at least 25 USDC; User B at least 10 USDC; 0.1 SOL each | `docs/deployment.md` §1.4 |
| Deployer funding floor | About 7-9 SOL (program-data rent plus a same-size temporary buffer account) | `docs/deployment.md` §1.1 |

**How to refresh:** re-read `services/automation/src/index.ts` for the live cron strings (they
are the single source of truth the service runs); re-read `docs/deployment.md` §2 after any new
settlement day is recorded there.

## E. Frontend metrics

Routes below are from running the web build inside the container today
(`docker exec -w /work meridian-web-devnet-e2e sh -c 'cd web && pnpm build'`):

| Route | Type |
| --- | --- |
| `/` | Static |
| `/_not-found` | Static |
| `/admin` | Static |
| `/api/price-history` | Dynamic (server route) |
| `/api/prices` | Dynamic (server route) |
| `/docs` | Static |
| `/docs/[slug]` | SSG, 4+ generated paths (`quick-start`, `how-contracts-work`, `trading`, + 4 more) |
| `/history` | Static |
| `/markets` | Static |
| `/portfolio` | Static |
| `/trade` | Static |
| `/trade/[ticker]` | Dynamic |

| Metric | Value | Source |
| --- | --- | --- |
| Poll intervals | Config 15 s, prices 15 s, books 15 s, positions 30 s, markets 30 s, automation status 10 s | `web/src/hooks/AppDataProvider.tsx` |
| Account-read batching | `getMultipleAccountsInfo`, 100 accounts per call | `web/src/hooks/AppDataProvider.tsx` |
| Event index cold build (worker) | 612 transactions in about three minutes, once, on the worker instead of in every browser | `AI_USAGE.md`, 2026-10-08 entry |
| Old per-browser chain replay | About three minutes to catch up an empty cache on roughly 600 transactions, paid again by every new tab/device/wallet | `DECISIONS.md` §23 |
| Chart library | `lightweight-charts` 5.2.1 | `DECISIONS.md` §26; `web/package.json` |

**How to refresh:** `pnpm --filter web build` inside the container for the current route list;
re-read `web/src/hooks/AppDataProvider.tsx` for poll intervals if they change.

## F. Cost metrics

Rent figures below are from `CLUSTER=devnet pnpm --filter @meridian/scripts run rent-estimate`,
run inside the container today — this is a live `getMinimumBalanceForRentExemption` query against
devnet's current rent rate, not a static constant:

| Account | Bytes | Rent (SOL) |
| --- | --- | --- |
| `Market` | 196 | 0.001646 |
| `Book` (capacity 16) | 2,176 | 0.011704 |
| `Book` (capacity 128) | 16,512 | 0.084531 |
| One mint | 82 | 0.001067 |
| One token account | 165 | 0.001488 |

| Rollup | Value |
| --- | --- |
| Per market, demo scale (Market + Book@16 + 2 mints + 3 token accounts) | 0.019949 SOL |
| Per market, production scale (Market + Book@128 + 2 mints + 3 token accounts) | 0.092776 SOL |
| Per day at 45 markets/day, demo scale | 0.8977 SOL |
| Per day at 45 markets/day, production scale | 4.1749 SOL |
| Program-data rent (deployed devnet binary, 623,328 bytes) | 3.167 SOL (`docs/deployment.md` §2) |
| Permanently unreclaimed rent per market (two SPL mints, no close instruction exists for a mint) | About 0.0029 SOL/market -> about 0.13 SOL/day at 45 markets/day, accumulating for as long as the deployment runs | `ARCHITECTURE.md` §4; `docs/architecture.md`'s former §7 |

**Note on the discrepancy with `docs/deployment.md`'s prose figures.** That document describes
the daily lifecycle cost as "on the order of 1.25 SOL" at demo scale and Phoenix-comparison math
elsewhere cites "~5.8 SOL/day" at production scale — both somewhat higher than the
`rent-estimate` rollup above (0.8977 / 4.1749 SOL/day). The script's own per-market multiplier
(45 markets/day) and account list (Market + Book + 2 mints + 3 token accounts) are stated in its
output; the prose figures may include additional transaction fee overhead or a different
per-market account count not reflected in the script. Neither this document nor
`docs/deployment.md` was changed to reconcile the two; both are reported here, with their
sources, rather than one silently overriding the other.

**What is unknown / not verified this pass:**

- The `Config` account's exact 539-byte size was not independently re-derived this pass (the
  `rent-estimate` script does not print it); it is carried over from an earlier same-day
  reading of `programs/meridian/src/state/config.rs` and not re-verified here.
- Mainnet rent rates and mainnet transaction fee costs are not estimated anywhere in this repo;
  everything above is devnet rent only.
- No dollar-denominated cost is computed anywhere in this repo; all figures are in SOL.

**How to refresh:** `CLUSTER=devnet pnpm --filter @meridian/scripts run rent-estimate` inside the
container for live rent figures.
