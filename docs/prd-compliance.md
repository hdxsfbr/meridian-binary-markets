# PRD Compliance Audit

Produced as a read-only documentation task. Cross-references `docs/PRD.md` (FR-1…FR-12, §5.1–5.4,
§6, §7, §8) against the actual program, automation, SDK, frontend and test code, plus `DECISIONS.md`
for deliberate, disclosed deviations. No code was changed to produce this audit; gaps found here are
reported, not fixed.

## Gaps and noted deviations (worst first)

- **Gap — §5.2 invariant "Yes payout + No payout = $1.00 at settlement"**: no test computes or
  asserts the literal sum. Coverage is indirect only (binary `Outcome` enum, `WrongSide` rejection of
  the losing side, and separate per-outcome tests). `programs/meridian/src/state/market.rs:115-119`,
  `programs/meridian/tests/redeem_winning.rs:337-436`.
- **Gap — §5.2 invariant "tokens only created via Mint Pair, destroyed via Redeem"**: no negative test
  attempts to mint outside `mint_pair_core` or destroy outside redeem/burn. Enforcement is structural
  only (mint authority is the Market PDA) and untested as a regression.
- **Gap — Performance benchmark "sub-second transaction finality"**: no benchmark or test in this repo
  measures confirmation latency. The claim (`README.md:67`) rests on Solana's platform property, not
  on anything measured here.
- **Gap — §7 Frontend testing, "order book rendering from both perspectives"**: no Playwright test
  asserts the Yes/No perspective toggle; `web/e2e/*.spec.ts` contains no reference to "perspective".
- **Gap — §7 Frontend testing, "portfolio and P&L accuracy"**: `portfolio.spec.ts` only asserts a
  realized-P&L string renders and that a redeem increases USDC balance by the winning quantity; no
  test asserts a specific computed P&L number.
- **Gap — §7 Integration testing, "full lifecycle create → mint → trade → settle → redeem"**: the one
  test named for this (`close.rs:570-597`) skips the trade step entirely (create → mint → settle →
  redeem → close); no single test chains an actual order-book fill between mint and settle.
- **Gap — §8 Deliverable "Demo video"**: only a shooting script (`docs/demo-script.md`) and a
  deliverables-checklist line exist; no video file or link was found in this repo.
- **Partial/stale doc — `docs/deployment.md:192`**: snapshots `Config.tickers` as `TSLA/QQQ/VOO`, but
  the file's own later line 198 and `DECISIONS.md` §20's "Update, 2026-10-08" both record the switch
  to the full PRD seven (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA) the same day. Note: this is a
  documentation staleness issue in a file this audit was told not to edit — flagged, not fixed.
- **Met with noted deviation — demo-scale book capacity**: 16 orders/side instead of the 128
  production default, to fit one faucet grant (`DECISIONS.md` §6, "Corrected 2026-10-06"). Ticker/
  strike count is explicitly *not* reduced by this change — all seven stocks, every day, still run.
- **Met with noted deviation — FR-6 redemption design**: `redeem_winning` takes only the winning
  side's token account, not both legs (`DECISIONS.md` §11); this is a deliberate simplification of an
  earlier two-account design, not a PRD gap — it matches FR-6's "winners sign one transaction."
- **Met with noted deviation — §5.1 "Create Strike Market"**: Book creation is split out of
  `create_market`/`add_strike` into its own idempotent `create_book` instruction, called repeatedly,
  because of Anchor's 10,240-byte per-transaction account-growth cap (`DECISIONS.md` §7,
  "Wave 2, program tests").
- **Met with noted deviation — on-chain trading guard beyond PRD's literal text**: `mint_pair`,
  `place_order`, `buy_no_market`, `buy_no_limit`, `sell_no_market` all require
  `Clock::now < market.close_ts` on-chain (`MarketClosed` error), not just a UI hide
  (`DECISIONS.md` §16). `cancel_order`, `redeem_pair`, `redeem_winning` remain callable after close.
- **Addition beyond PRD §5.4 — Docs tab and Admin page**: the PRD's literal frontend page list is
  Landing/Markets/Trade/Portfolio/History only. The shipped app adds an Admin page and a seven-page
  in-app Docs tab (`DECISIONS.md` §22). Noted as additions, not gaps.
- **Met with noted deviation — Settlement benchmark vs retry window**: the automation settle job
  reconciles and settles within seconds on a healthy run (devnet evidence: settled by 16:00:52 ET
  against a 16:00:00 close, `docs/deployment.md:198`), well inside the PRD's 10-minute target. But on
  an oracle failure, the retry/alert window extends to 15 minutes (`DECISIONS.md` §12), which exceeds
  the 10-minute benchmark in that failure case by design — `admin_settle_override` is the intended
  escape hatch.
- **Met with noted deviation — listed ticker set churn**: briefly TSLA/QQQ/VOO when the Pyth key only
  covered three equity feeds, switched back to the full PRD seven the same day once the remaining
  feeds were granted (`DECISIONS.md` §20, both entries dated 2026-10-08).

## Requirement-by-requirement table

### Functional requirements (§5)

| ID | Summary | Status | Evidence | Notes |
|---|---|---|---|---|
| FR-1 | Daily market creation, all 7 stocks, strike algorithm w/ dedup | Met | `services/automation/src/jobs/morning.ts:141-182` (per-ticker loop, calls `createMarket`); `packages/sdk/src/strikes.ts:59-84` (±3/±6/±9% offsets, round to $10, dedup via `Set`); `docs/deployment.md:198` (all 7 PRD tickers settled on devnet 2026-10-08) | Ticker set is on-chain `Config` data, not hardcoded (DECISIONS §20) |
| FR-2 | Mint/redeem, $1.00 invariant | Met | `programs/meridian/src/instructions/mint_pair.rs:54-161`; `programs/meridian/src/instructions/redeem_pair.rs`; invariant property test `programs/meridian/tests/mint_redeem.rs:340-392` (25 random mint/redeem steps, vault == pairs*$1 after every step) | |
| FR-3 | Order book trading, price-time priority, real-time updates | Met | `programs/meridian/src/book/matching.rs:67-108` (price-time priority); `web/src/hooks/useBook.ts:5,78` (`onAccountChange` live subscription, not polling); `web/e2e/trade.spec.ts:42` (cross-browser-context book update visible within 1s) | |
| FR-4 | Four trade paths, atomic Buy No market, rest-only Buy No limit | Met | `programs/meridian/src/instructions/buy_no_market.rs:91-104,123-163` (mint+sell one tx); `buy_no_limit.rs:51-61` (`WouldCross` guard, rest-only); tests `programs/meridian/tests/trade_paths.rs` (per-path tests, e.g. L513-548, L797-816, L866-895) | |
| FR-5 | Oracle settlement, close_ts gate, freshness+confidence, immutable outcome, 30s/15min retry | Met | `programs/meridian/src/instructions/settle_market.rs:16-67`; `programs/meridian/src/oracle/mod.rs:29-73` (staleness L45-52, confidence L63-66); immutability test `programs/meridian/tests/settle.rs:143-162`; automation retry `services/automation/src/jobs/settle.ts:35-36,159-163,326-336` | |
| FR-6 | Redemption, one tx, unredeemed stays redeemable | Met with noted deviation | `programs/meridian/src/instructions/redeem_winning.rs:135-181` (single winning-side account, doc comment L172-176 explains the earlier two-account design was removed) | `DECISIONS.md` §11 — self-redemption design, no admin batch redemption exists |
| FR-7 | Wallet integration & portfolio, P&L, settlement price/outcome | Met with noted deviation | `web/src/app/portfolio/page.tsx` (doc comment lines 3-6); `web/src/lib/positions-view.ts` (`costBasisMicro`/`realizedPnlMicro`) | P&L uses average-cost-per-leg accounting with a losing-leg write-off at settlement, not simple "entry vs sale price" (`DECISIONS.md` §13) — a deliberate, disclosed accounting choice |
| FR-8 | Position constraints, frontend guidance | Met | `web/src/components/TradePanel.tsx:148-162,271-276` (gates on actual per-leg balance, not net) | Sell-gating logic changed 2026-10-07 to gate on the actual leg balance rather than net holdings (`DECISIONS.md` §19); the pair exemption on the buy side is unchanged |
| FR-9 | Market maker flow, exposure/fills/P&L dashboard | Met | `programs/meridian/src/instructions/buy_no_limit.rs` / `place_order.rs` (resting-order mechanics); `web/src/app/portfolio/page.tsx` (exposure/fills/P&L) | No separate "maker dashboard" page exists; the market-maker view is the same Portfolio page plus the Trade panel's limit-order controls |
| FR-10 | Admin strike management | Met | `programs/meridian/src/instructions/create_market.rs:23-110` (`handle_add_strike`, L34); `web/src/app/admin/page.tsx:34` (`addStrike` UI action) | |
| FR-11 | Admin settle override, enforced time delay | Met | `programs/meridian/src/instructions/admin_settle_override.rs:20-55`; floor `programs/meridian/src/state/config.rs:13,155-156` (`MIN_OVERRIDE_DELAY_SECS=3600`, `effective_override_delay`); test `programs/meridian/tests/override.rs:47-82` | |
| FR-12 | Pause/unpause | Met | `programs/meridian/src/instructions/pause.rs:12-30`; consumed by `mint_pair.rs:67`, `place_order.rs:68`, `buy_no_market.rs:45`, `buy_no_limit.rs:29`, `sell_no_market.rs:44`; `redeem_winning.rs`/`redeem_pair.rs`/`cancel_order.rs` carry no pause check (DECISIONS §11) | |

### 5.1 Required on-chain functions

| Function | Status | Evidence | Notes |
|---|---|---|---|
| Initialize Config | Met | `programs/meridian/src/instructions/config.rs:83-114` (admin, publishers, oracle provider/program, tickers, staleness/confidence params, `config.validate()`) | Deployment-time risk, documented not fixed: `initialize_config` has no check on who calls it first (DECISIONS §7, "Deployment-risk note") |
| Create Strike Market | Met with noted deviation | `programs/meridian/src/instructions/create_market.rs:23-110` (shared handler, L23 `handle_create_market`); Book created separately via `create_book.rs` | Split from a single-shot creation into Market-creation + repeated idempotent `create_book` calls, due to Anchor's 10,240-byte per-tx account-growth cap (`DECISIONS.md` §7) |
| Add Strike | Met | `programs/meridian/src/instructions/create_market.rs:34` (`handle_add_strike`, same shared handler as Create Strike Market); `programs/meridian/src/instructions/mod.rs:3-4,14-15` | No separate `add_strike.rs` file; same handler, different entry point in `lib.rs:37-57` |
| Mint Pair | Met | `programs/meridian/src/instructions/mint_pair.rs:54-161` | Guards in order: paused, market open, `MarketClosed` (close_ts), qty>0 |
| Settle Market | Met | `programs/meridian/src/instructions/settle_market.rs:16-67`; `programs/meridian/src/oracle/mod.rs:29-73` | |
| Admin Settle (Override) | Met | `programs/meridian/src/instructions/admin_settle_override.rs:20-55` | |
| Redeem | Met with noted deviation | `programs/meridian/src/instructions/redeem_pair.rs`, `redeem_winning.rs:135-181` | Split into two instructions (pair redemption at any time, winning-only redemption post-settlement); winning-only path needs just one token account (DECISIONS §11) |
| Pause / Unpause | Met | `programs/meridian/src/instructions/pause.rs:12-30` | |

### 5.2 Invariants

| Invariant | Status | Evidence | Notes |
|---|---|---|---|
| Vault balance = $1.00 × total pairs minted | Met | `programs/meridian/tests/mint_redeem.rs:340-392` (`property_random_mint_redeem_sequence_preserves_vault_equation`, asserted after every mint and every redeem step, not just after mint); direct tests L270-291 (after mint), L295-326 (after redeem); post-settlement form `mint_redeem.rs:676-721`, `redeem_winning.rs:571-596` | |
| Yes payout + No payout = $1.00 at settlement | Gap | `programs/meridian/src/state/market.rs:115-119` (structural: `resolve` picks exactly one outcome); `programs/meridian/tests/redeem_winning.rs:337-436` (per-side tests, no summed assertion) | No test literally asserts `yes_payout + no_payout == 1_000_000`; coverage is indirect only |
| Tokens only created via Mint Pair, destroyed via Redeem | Gap | `programs/meridian/src/instructions/create_market.rs:139,149` (mint authority = Market PDA, only signer of `mint_to`); `programs/meridian/tests/create_market.rs:80-84` (asserts mint authority at creation) | No negative/regression test attempts an unauthorized mint or burn outside the sanctioned instructions; enforcement is structural (PDA signer) only |
| Settlement outcome immutable once written | Met | `programs/meridian/tests/settle.rs:143-162` (`second_settle_is_refused_and_state_unchanged`); mirror for override `programs/meridian/tests/override.rs:99-116` | |

### 5.3 Automation service

| Job | Status | Evidence | Notes |
|---|---|---|---|
| Morning strike-creation (~8:00 AM ET) | Met | `services/automation/src/index.ts:175-179` (cron registration); `services/automation/src/jobs/morning.ts:141-182` (reads previous close, computes/dedupes strikes via `packages/sdk/src/strikes.ts:59-84`, calls create-market per strike, retries with backoff via `services/automation/src/chain.ts:235-253`) | |
| Settlement (~4:05 PM ET target) | Met with noted deviation | `services/automation/src/index.ts:185-192` (cron at 16:00:30 ET); `services/automation/src/jobs/settle.ts:13-18` (one frozen closing observation per ticker, doc comment); retry constants L35-36 (30s / 15min); reconciliation L119-141,159,321; Hermes 401/403/429 treated as terminal L215-229 | Start time (16:00:30, a 30s buffer) and the single-frozen-observation design are deliberate refinements beyond the PRD's literal "~4:05 PM" / implicit "re-check each retry" framing, documented in `DECISIONS.md` §12 |

### 5.4 Frontend pages

| Page | Status | Evidence | Notes |
|---|---|---|---|
| Landing | Met | `web/src/app/page.tsx` | |
| Markets | Met | `web/src/app/markets/page.tsx` | |
| Trade | Met | `web/src/app/trade/[ticker]/page.tsx`; both-perspective toggle `web/src/components/BookView.tsx:1-2,23,36-52`; countdown `web/src/components/Countdown.tsx`; payoff line `web/src/components/PayoffLine.tsx:11-17` | |
| Portfolio | Met | `web/src/app/portfolio/page.tsx` (lines 3-6, 139-247, 316-324) | |
| History | Met | `web/src/app/history/page.tsx:3-9,20-34` (execution log grouped by day) | |
| Admin + Docs (not in PRD §5.4's literal list) | Addition beyond PRD | `web/src/app/admin/page.tsx` (not linked from product nav, per its own comment L6-10); `web/src/app/docs/page.tsx`, `web/src/app/docs/[slug]/page.tsx` (7 markdown pages under `web/content/docs/`) | `DECISIONS.md` §22: Docs tab added so the public deployment is self-explanatory; Admin page is the FR-10/11/12 operational surface, outside the trader-facing page list |

### Performance benchmarks

| Benchmark | Status | Evidence | Notes |
|---|---|---|---|
| Sub-second transaction finality | Gap | `README.md:67` (states the target; no measurement in-repo) | No benchmark/test in this repo measures confirmation latency; rests on Solana's platform property, not a local measurement |
| Settlement within 10 minutes of close | Met with noted deviation | `docs/deployment.md:198` (devnet: settled by 16:00:52 ET against 16:00:00 close, all 7 tickers, no override) | Healthy-path settlement is seconds, well inside 10 min; the oracle-failure retry/alert window is 15 minutes by design (`DECISIONS.md` §12), which exceeds the benchmark in that failure case — `admin_settle_override` is the designed fallback |
| Real-time order book updates | Met | `web/src/hooks/useBook.ts:5,78` (`onAccountChange` subscription, not polling); `web/e2e/trade.spec.ts:42` (update visible cross-context within 1s, no reload) | |
| Oracle price staleness under 5 minutes | Met | `programs/meridian/src/state/config.rs:16` (`MAX_STALENESS_SECS: u32 = 300`); enforced `programs/meridian/src/oracle/mod.rs:45-52`; tested `programs/meridian/tests/oracle.rs:176-189`, boundary cases L440-544 | |

### §6 Constraints

| Constraint | Status | Evidence | Notes |
|---|---|---|---|
| Chain: Solana, sub-second-finality L1/L2 | Met with noted deviation | `DECISIONS.md` §3 (Solana + Anchor chosen over EVM L2/HyperLiquid, with rationale) | Deviation is the devnet-only deployment, which the PRD itself requires/permits for Solana (§6: "deployment to Solana devnet is required to pass") |
| Rust + Anchor smart contract | Met | `programs/meridian/Cargo.toml` (Anchor 1.2.1 per `DECISIONS.md` §8); all instruction files under `programs/meridian/src/instructions/*.rs` | |
| TypeScript + React/Next.js frontend | Met | `web/` (Next.js 16.4 per `DECISIONS.md` §8); `web/src/app/*/page.tsx` | |
| TypeScript/Node.js automation service | Met | `services/automation/src/*.ts` (Node 22, per `DECISIONS.md` §8 update) | |
| CLOB: build vs. use existing (Phoenix) | Met with noted deviation | `DECISIONS.md` §6 (resolved by spike `docs/spikes/2026-10-05-phoenix-devnet.md`: Phoenix rent exceeds devnet faucet budget by an order of magnitude, and seats conflict with FR-4's one-tx atomicity); in-program CLOB at `programs/meridian/src/book/matching.rs` | Chose to build, which the PRD itself calls "more ambitious, demonstrates deeper understanding" |
| Oracle staleness + confidence check | Met | `programs/meridian/src/oracle/mod.rs:29-73`; `DECISIONS.md` §4 (Pyth behind a provider interface, mock fallback until Pyth Pro token; superseded 2026-10-08 per `docs/risks-and-limitations.md` §2 — real Pyth now live for all 7 tickers) | |
| `.env.example` present, secrets via env vars | Met | `/.env.example` (repo root; placeholder/empty values, e.g. `PYTH_API_KEY=`, `ALERT_WEBHOOK_URL=`; header states "Never commit the real file") | |
| Never mainnet / real funds | Met | `services/automation/src/config.ts:159-164` (rejects `SOLANA_CLUSTER=mainnet-beta` outright); `services/automation/src/chain.ts:54,62-73` (`assertGenesisHash` refuses mainnet-beta's genesis hash unconditionally); `scripts/deploy.ts:10` | |

### §7 Testing requirements

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| Program unit: mint/settle/redeem + §5.1 functions | Met | `programs/meridian/tests/mint_redeem.rs`, `settle.rs`, `redeem_winning.rs`, `override.rs`, `pause.rs`, `config.rs`, `create_market.rs`, `book.rs` | |
| Program unit: settlement at/above/below strike | Met | `programs/meridian/tests/redeem_winning.rs:337-436` (Yes-wins and No-wins cases, at-or-above rule exercised via `Market::resolve`, `state/market.rs:115-119`) | |
| Program unit: $1.00 invariant across all prices | Met with noted deviation | `programs/meridian/tests/redeem_winning.rs:337-436` per-side; see §5.2 row above | No single test sums Yes+No payout; see Gap noted in §5.2 |
| Program unit: vault-balance invariant after every mint and redeem | Met | `programs/meridian/tests/mint_redeem.rs:340-392` (property test over 25 random mint/redeem steps) | |
| Program unit: oracle validation (stale, wide-confidence, valid) | Met | `programs/meridian/tests/oracle.rs:176-189` (stale), `209-223` (wide confidence), `157-173` (valid); boundary cases L440-544 | |
| Program unit: admin override time-delay enforcement | Met | `programs/meridian/tests/override.rs:47-82` | |
| Integration: full lifecycle create → mint → trade → settle → redeem | Gap | `programs/meridian/tests/close.rs:570-597` (`full_lifecycle_mint_settle_redeem_winning_and_redeem_pair_then_both_closes_succeed`) | This test skips the trade step (create → mint → settle → redeem → close); no test chains an order-book fill between mint and settle |
| Integration: all four trade paths | Met | `programs/meridian/tests/trade_paths.rs` (per-path tests, e.g. L513-548 Buy No market, L797-816 Buy No limit, L866-895 Sell No market; Buy/Sell Yes via `book.rs:366-410,882-915`) | |
| Integration: multi-user scenario (one mints+quotes, another takes, both redeem) | Met | `programs/meridian/tests/trade_paths.rs:477-509` (separate maker wallet seeds bids/asks), consumed by a different taker wallet at e.g. L866-895 | |
| Frontend: wallet connection | Met | `web/e2e/portfolio.spec.ts:25` | |
| Frontend: order placement and signing | Met | `web/e2e/trade.spec.ts:109` | |
| Frontend: real-time price display | Met with noted deviation | `web/e2e/trade.spec.ts:42` | Test proves real-time order-book update visibility, not ticker price-feed display specifically |
| Frontend: order book rendering from both perspectives | Gap | — | No Playwright test references the Yes/No perspective toggle; component exists (`BookView.tsx`) but is untested at the e2e layer |
| Frontend: position-constraint enforcement | Met with noted deviation | `web/e2e/trade.spec.ts:136` | Asserts the post-trade position outcome, not an attempted-violation-then-guided-exit scenario |
| Frontend: portfolio and P&L accuracy | Gap | `web/e2e/portfolio.spec.ts:36` | Only confirms a realized-P&L string renders; no assertion of a specific computed value |
| Frontend: settlement display and redeem flow | Met | `web/e2e/portfolio.spec.ts:52`; `web/e2e/admin.spec.ts:33` | |
| Reproducible deployment scripts | Met | `docs/deployment.md` (deploy/init-config/lifecycle make targets); `README.md:73,115,129` (`make dev`) | |

### §8 Required deliverables

| Deliverable | Status | Evidence | Notes |
|---|---|---|---|
| Source code (program, frontend, automation) | Met | `programs/meridian/`, `web/`, `services/automation/`, `packages/sdk/` | |
| Technical documentation | Met | `docs/architecture.md` (how); `DECISIONS.md` (why — chain §3, oracle §4, CLOB §6); `docs/risks-and-limitations.md` | |
| Deployment guide | Met with noted deviation | `docs/deployment.md` (deployed program id, cluster, reproducible scripts); `README.md:73` (`make dev`) | `docs/deployment.md:192`'s ticker snapshot (TSLA/QQQ/VOO) is stale against the file's own later line 198 and `DECISIONS.md` §20's same-day update to the full PRD seven — flagged, not corrected here per this task's scope |
| Test results | Met | Rust tests under `programs/meridian/tests/*.rs`; SDK tests `packages/sdk/test/*.test.ts`; e2e `web/e2e/*.spec.ts` | Coverage gaps noted above (full-lifecycle-with-trade test, perspective rendering, P&L accuracy, Yes+No sum invariant) |
| Demo video | Gap | `docs/demo-script.md` (shooting script only); `README.md:219,246` (lists it as a deliverable) | No actual video file or link found in the repository |
| AI usage log | Met | `AI_USAGE.md` (dated entries from 2026-10-05 through 2026-10-08, written incrementally per its own header) | |
