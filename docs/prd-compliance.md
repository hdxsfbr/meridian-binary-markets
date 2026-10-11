# PRD compliance audit

Cross-references `docs/PRD.md` (FR-1…FR-12, §3.3, §5.1–5.4, performance benchmarks, §6, §7, §8, §9)
against the program, automation worker, SDK, frontend, tests and docs as of 2026-10-11. This
revision replaces the 2026-10-09 audit: it was redone from scratch (an independent read of the PRD
against the code, then reconciled by hand) after the first one turned out to be stale, and the gaps
it found were fixed in the same wave rather than only reported. Deliberate deviations are listed
with their `DECISIONS.md` entry.

## Status summary

Every functional requirement (FR-1…FR-12), every required on-chain function (§5.1), the four
on-chain invariants (§5.2), both automation jobs (§5.3), the five frontend pages and key elements
(§5.4), the performance benchmarks, the §6 constraints, the §7 test list and the §8 deliverables are
met, with one partial noted first below.

## Open items

- **§7 Frontend testing, "real-time price display"**: unit-tested (`web/src/lib/hermes-prices.test.ts`)
  and the live order book is e2e-tested; the ticker price strip itself has no browser test. Partial,
  accepted: the strip is a presentation of the same price feed the unit tests cover.

## Fixed in the 2026-10-11 wave

- **FR-10 "add or adjust strikes"**: only add existed. Added the admin `remove_strike` instruction
  (open market, zero pairs outstanding, empty book, escrows and vault; closes everything, rent to the
  admin, the strike can then be created again) and an "Adjust" action on the Admin page that removes
  an unused strike and adds the new one. A strike with minted contracts or orders on the book is
  locked, with the reason shown; the admin adds a strike instead (`DECISIONS.md`, "Adjusting a
  strike means replacing an unused one").
- **§5.3 morning job "alert on failure"**: the job retried with backoff and logged, but never called
  the alert webhook; only settlement did. It now sends one alert per ticker whose ladder could not be
  completed, through the same module as settlement.
- **§5.2 "Yes payout + No payout = $1.00" had no direct test**: added a sweep over settlement prices
  below, at and above the strike asserting the per-pair payouts sum to exactly $1.00, exactly one
  side redeems, and the vault ends empty.
- **§5.2 "tokens only created via Mint Pair, destroyed via Redeem" had no negative test**: added
  direct `mint_to` / `burn` attempts on a Yes mint by the admin and by a stranger, both refused,
  supply unchanged.
- **§8 "Test results"**: there was no document with actual run output. `docs/test-results.md` now
  records a dated run of all four suites (program, SDK/worker, web unit, Playwright) and the devnet
  integration run.
- **§7 "order book rendering from both perspectives"** and **"portfolio and P&L accuracy"** had unit
  coverage only: Playwright tests added (`web/e2e/trade.spec.ts` book perspective test, asserting No
  prices are $1.00 minus Yes with sizes swapped; `web/e2e/portfolio.spec.ts` flow 6, asserting a
  hand-computed cost basis and realized P&L on the rendered page). Two older specs were found
  reading balances through the classic token program and fixed.
- **Performance benchmark "sub-second transaction finality"** was not measured: the lifecycle run
  now times every transaction send-to-confirmed and reports count, median, p95 and max
  (`KEY_METRICS.md`: 155 transactions, median 416 ms on the local validator).
- **Observability**: a `reconcile` job every 30 minutes audits every market's vault and token
  supplies against the invariants, overdue settlement, today's ladder and job heartbeats, with one
  summary alert (`docs/risks-and-limitations.md` §12).
- **§9 Traceability**: see the note at the end of this file.

## Deliberate deviations (disclosed, not gaps)

- **§3.3 "read previous closing price from the oracle"**: the morning job reads the previous
  day's close from Pyth's history API over HTTPS (with a Finnhub fallback), not from an on-chain
  Pyth account. Pyth posts no price history on chain, so there is no account to read; the data is
  the same oracle's, by a different path. Settlement itself reads the oracle on chain inside the
  settle transaction.
- **§4 timeline**: one job at 08:00 ET reads the previous close and creates the markets and books
  in the same pass; they are visible and mintable as soon as they exist rather than at 08:30 and
  09:00. Settlement starts at 16:00:30 ET (a 30 s buffer after the close) rather than ~16:05
  (`DECISIONS.md` §12).
- **§5.1 "only after 4:00 PM ET"**: the on-chain settle guard originally accepted a quote published
  up to 60 s before the close (`min_publish_offset_secs`); the worker never used that slack (it
  discards any pre-close observation), and on 2026-10-11 the config value was set to 0 so the
  program itself requires a publish time at or after the close.
- **§3.3 "optionally the rounded previous close as a 7th strike"**: always included.
- **§5.4 payoff line**: reads "You win $1.00 if META closes at or above $680" rather than the PRD's
  "closes above", because ties go to Yes (§3.1); with no offer on the book the first clause is
  "No offers yet." instead of a price.
- **§5.2 "tokens only destroyed via Redeem"**: creation is enforced (mint authority is the market).
  A holder can still burn their own tokens through the token program directly; Token-2022 offers no
  way to forbid an owner's burn. Doing so only forfeits that holder's own claim; the dollar stays in
  the vault and is never paid to anyone else.
- **Close time is an admin argument**: `create_market` requires `close_ts` to be in the future but
  does not derive it from the trading day on chain; the worker computes 16:00:00 ET for the day.
  Admin-only input, not reachable by users.
- **Integration test gating**: `tests/integration/lifecycle.test.ts` skips itself unless
  `CLUSTER=localnet`, which `make test-integration` sets; running the file any other way reports a
  skip, not a pass.
- **§5.2 vault invariant uses `>=`, not `==`** (`mint_pair.rs`): the vault check tolerates unsolicited
  direct USDC transfers to the vault so a stranger cannot brick minting by sending dust; redemptions
  pay exactly `qty × $1.00`, so a surplus is never paid out and the PRD's property (every pair backed
  by exactly $1.00) holds. Test `unsolicited_vault_deposit_is_tolerated_and_never_paid_out`.
  `DECISIONS.md`, "The vault check is at-least, not exactly".
- **FR-6 redemption**: `redeem_winning` takes only the winning side's token account
  (`DECISIONS.md` §11); matches "winners sign one transaction".
- **§5.1 Create Strike Market**: book creation is a separate idempotent `create_book` instruction
  called until the book reaches full size, because of Anchor's 10,240-byte per-transaction account
  growth cap (`DECISIONS.md` §7).
- **Trading stops at the close on chain** (`MarketClosed`), not only in the UI (`DECISIONS.md` §16).
- **Settlement retry window is 15 minutes** on oracle failure, beyond the 10-minute benchmark in that
  failure case; `admin_settle_override` is the designed fallback (`DECISIONS.md` §12).
- **Demo-scale book capacity** of 16 orders per side on devnet instead of 128 (`DECISIONS.md` §6).
- **Strike grid is magnitude-dependent** ($10 / $100 / $500 by price) so a crypto feed can be listed
  for weekend recordings; every PRD equity lands on the PRD's $10 step, verified against the PRD's
  own META and AAPL examples in `packages/sdk/src/strikes.test.ts` (`DECISIONS.md` §30).
- **Listed set churn**: BTC replaced TSLA for the 2026-10-10/11 weekend recordings and TSLA was
  restored the same night; the on-chain config now lists the PRD seven (`DECISIONS.md` §30).
- **Additions beyond §5.4**: an Admin page (the FR-10/11/12 surface) and an in-app Docs tab
  (`DECISIONS.md` §22).
- **Token-2022 mints** with on-chain names and a metadata URI so wallets show "AAPL ≥ $340 Yes Oct 10"
  instead of "Unknown Token" (`DECISIONS.md` §28–29); classic-mint markets remain supported.

## Requirement-by-requirement

### Functional requirements (§5)

| ID | Summary | Status | Evidence |
|---|---|---|---|
| FR-1 | Daily creation, 7 stocks, §3.3 algorithm with dedup | Met | `services/automation/src/jobs/morning.ts` (per-ticker loop, `strikeLadder`, `createMarket`/`createBookUntilDone` per strike, retry with backoff); `packages/sdk/src/strikes.ts` (`strikeLadder`: ±3/6/9 %, nearest $10, dedup); `packages/sdk/src/strikes.test.ts` (PRD's META → 7 strikes, AAPL → 5 after dedup); `KEY_METRICS.md` (unattended devnet days) |
| FR-2 | Mint / redeem, $1.00 invariant | Met | `programs/meridian/src/instructions/mint_pair.rs`, `redeem_pair.rs`; `tests/mint_redeem.rs` (`property_random_mint_redeem_sequence_preserves_vault_equation`) |
| FR-3 | One book per strike, price-time priority, real-time updates | Met | `programs/meridian/src/book/matching.rs`; `web/src/hooks/useBook.ts` (account subscription); `web/e2e/trade.spec.ts` (second browser sees a new order within 1 s) |
| FR-4 | Four trade paths; atomic Buy No market; rest-only Buy No limit | Met | `packages/sdk/src/intent.ts`; `buy_no_market.rs`, `buy_no_limit.rs` (`WouldCross`), `sell_no_market.rs`, `place_order.rs`; `tests/trade_paths.rs` |
| FR-5 | Oracle settlement after the close, freshness + confidence, immutable, 30 s / 15 min retry then alert | Met | `settle_market.rs`; `oracle/mod.rs` (staleness, confidence); `tests/settle.rs` (`second_settle_is_refused_and_state_unchanged`); `services/automation/src/jobs/settle.ts` (`RETRY_INTERVAL_MS`, `ALERT_WINDOW_MS`), `alert.ts` |
| FR-6 | One-transaction redemption, redeemable indefinitely | Met | `redeem_winning.rs`; `tests/redeem_winning.rs` (`redeem_one_week_later_succeeds`) |
| FR-7 | Wallet, balance, positions, fills, realized P&L, settlement price and outcome | Met | `packages/sdk/src/pnl.ts`; `web/src/app/portfolio/page.tsx`; `web/src/lib/positions-view.ts`; worker-served event index (`services/automation/src/events-index.ts`, `web/src/lib/events-cache.ts`) |
| FR-8 | Position constraints with guidance | Met | `packages/sdk/src/intent.ts` (`checkGating`: `closeNoFirst` / `closeYesFirst`); `web/src/components/TradePanel.tsx`; `web/e2e/trade.spec.ts` ("Close your No position first") |
| FR-9 | Maker flow: mint, quote, exposure, fills, P&L | Met | `web/src/components/MakerPanel.tsx`, `MakerQuoteForm.tsx`, `web/src/lib/maker-view.ts` |
| FR-10 | Admin adds or adjusts strikes | Met (2026-10-11) | `create_market.rs` (`handle_add_strike`); `remove_strike` (see "Fixed in the 2026-10-11 wave"); `web/src/lib/admin-tx.ts` (`addStrike`, `removeStrike`, `adjustStrike`); `web/src/app/admin/page.tsx` |
| FR-11 | Admin settle override after an enforced delay | Met | `admin_settle_override.rs` (`effective_override_delay`, floor `MIN_OVERRIDE_DELAY_SECS`); `tests/override.rs` |
| FR-12 | Pause / unpause minting and trading | Met | `pause.rs`; consumed by every mint and trade instruction; redemption and cancel stay callable (`tests/mint_redeem.rs` `redeem_pair_succeeds_while_paused_then_mint_resumes_after_unpause`) |

### §5.1 Required on-chain functions

| Function | Status | Evidence |
|---|---|---|
| Initialize Config | Met | `instructions/config.rs` |
| Create Strike Market | Met (book sized by `create_book`) | `create_market.rs`, `create_book.rs` |
| Add Strike | Met | `create_market.rs` (`handle_add_strike`) |
| Mint Pair | Met | `mint_pair.rs` |
| Settle Market | Met | `settle_market.rs`, `oracle/mod.rs` |
| Admin Settle (Override) | Met | `admin_settle_override.rs` |
| Redeem | Met | `redeem_pair.rs`, `redeem_winning.rs` |
| Pause / Unpause | Met | `pause.rs` |

### §5.2 Invariants

| Invariant | Status | Evidence |
|---|---|---|
| Vault balance = $1.00 × pairs minted | Met (at-least check, see deviations) | `tests/mint_redeem.rs` property test after every mint and redeem; `after_all_yes_redeemed_vault_is_empty_and_invariant_holds` |
| Yes payout + No payout = $1.00 at settlement | Met (2026-10-11) | binary `Outcome` (`state/market.rs`); price-sweep test added this wave (`tests/`, see `docs/test-results.md` for the name) |
| Tokens only via Mint Pair / Redeem | Met (2026-10-11) | mint authority = market PDA (`create_market.rs`); negative mint/burn test added this wave |
| Settlement immutable | Met | `tests/settle.rs`, `tests/override.rs` |

### §5.3 Automation service

| Job | Status | Evidence |
|---|---|---|
| Morning: previous close, strikes, create per strike, log, alert, retry with backoff | Met (alert added 2026-10-11) | `jobs/morning.ts`, `chain.ts` (`withRetry`), `alert.ts`; cron 08:00 ET in `index.ts` |
| Settlement: settle every open contract, 30 s retry for 15 min, then alert | Met | `jobs/settle.ts`, `alert.ts`; cron 16:00:30 ET |
| Both jobs on trading days only | Met (settle guard added 2026-10-11) | `morning.ts` and `settle.ts` both check `isTradingDay` against the NYSE calendar; `--force` for manual runs |
| Also shipped | — | intraday `extend` job (`DECISIONS.md` §27), nightly `reclaim` job, a `reconcile` audit every 30 minutes (vault and supply invariants per market, overdue settlement, today's ladder, job heartbeats; one summary alert), `/status` and `/events` servers |

### §5.4 Frontend

| Page / element | Status | Evidence |
|---|---|---|
| Landing: explanation, live prices, connect wallet | Met | `web/src/app/page.tsx`, `web/src/components/landing/*` |
| Markets: grid of 7 with live prices and contract counts | Met | `web/src/app/markets/page.tsx`, `TickerCard.tsx` |
| Trade: strike list, book from both perspectives, four-action panel | Met | `web/src/app/trade/[ticker]/page.tsx`, `BookView.tsx`, `TradePanel.tsx` |
| Portfolio: positions, outcomes, P&L, redeem | Met | `web/src/app/portfolio/page.tsx` |
| History: execution log | Met | `web/src/app/history/page.tsx` |
| Contract cards with strike, Yes/No prices, implied probability | Met | `TickerCard.tsx`, `StrikeList.tsx` |
| Settlement countdown | Met | `Countdown.tsx` |
| Plain payoff line | Met | `PayoffLine.tsx` |
| Position-aware trade panel | Met | `TradePanel.tsx` (FR-8) |

### Performance benchmarks

| Benchmark | Status | Evidence |
|---|---|---|
| Sub-second finality | Met, measured on localnet | `scripts/lib/lifecycle/latency.ts`; `KEY_METRICS.md` (median 416 ms, p95 436 ms over 155 transactions); devnet confirmations are the public cluster's |
| Settlement within 10 minutes of close | Met, measured | `KEY_METRICS.md` (devnet settlements 40–55 s after the close on 2026-10-08/09) |
| Real-time order book updates | Met | `useBook.ts` subscription; `web/e2e/trade.spec.ts` |
| Oracle staleness under 5 minutes | Met | `config.rs` default `max_staleness_secs = 300`; `tests/oracle.rs` boundary tests at 300 s / 301 s |

### §6 Constraints

| Constraint | Status | Evidence |
|---|---|---|
| Chain with sub-second finality; devnet deployment with reproducible scripts | Met | Solana devnet, program `3XQgqYNXPeZr5o2NUmnuPm9hk5mPrZpiEsFE62pjVkBn`; `docs/deployment.md`; `Makefile` (`deploy`, `init-config`, `lifecycle`, `jobs`) |
| Rust + Anchor, TypeScript + Next.js, Node worker | Met | `programs/meridian`, `web`, `services/automation` |
| One book per strike; build or reuse a CLOB, justified | Met | in-program book; `DECISIONS.md` §6 and the Phoenix spike |
| Oracle with previous close, 4 PM close, on-chain read, staleness and confidence checks, justified | Met | Pyth pull oracle via the receiver program; `oracle/mod.rs`; `DECISIONS.md` §4 and later Pyth entries |
| Secrets via env, `.env.example` | Met | `.env.example` lists every variable read by the program scripts, the worker and the web app (audited 2026-10-11) |
| Never mainnet / real funds | Met | `services/automation/src/config.ts` and `chain.ts` refuse mainnet-beta; `scripts/deploy.ts` |
| Risks / limitations note, no compliance claims | Met | `docs/risks-and-limitations.md` |

### §7 Testing requirements

| Requirement | Status | Evidence |
|---|---|---|
| Program: mint, settle, redeem and all §5.1 functions | Met | `programs/meridian/tests/*.rs` (counts in `docs/test-results.md`) |
| Program: settlement at, above, below the strike | Met | `tests/settle.rs` (`at_or_above_rule_*`) |
| Program: $1.00 invariant across prices | Met (2026-10-11) | price-sweep test added this wave |
| Program: vault invariant after every mint and redeem | Met | `tests/mint_redeem.rs` property test |
| Program: oracle stale, wide-confidence, valid | Met | `tests/oracle.rs` |
| Program: override delay | Met | `tests/override.rs` |
| Integration: full lifecycle create → mint → trade → settle → redeem | Met | `tests/integration/lifecycle.test.ts` driving `scripts/lifecycle.ts` on a fresh local validator (`make test-integration`) |
| Integration: all four trade paths | Met | `scripts/lifecycle.ts` (each path asserted against a hand-computed fill); `tests/trade_paths.rs` |
| Integration: multi-user, one mints and quotes, another takes, both redeem | Met | `scripts/lifecycle.ts` (maker/taker, zero-sum P&L, vault ends at zero) |
| Frontend: wallet connection | Met | `web/e2e/portfolio.spec.ts` |
| Frontend: order placement and signing | Met | `web/e2e/trade.spec.ts` |
| Frontend: real-time price display | Partial | unit tests; order-book liveness e2e; no browser test of the price strip |
| Frontend: order book from both perspectives | Met (2026-10-11) | `web/e2e/trade.spec.ts` ("order book renders correctly from both the Yes and the No perspective"); `web/src/lib/book-perspective.test.ts` |
| Frontend: position-constraint enforcement | Met | `web/e2e/trade.spec.ts`; `packages/sdk/test/intent.test.ts` |
| Frontend: portfolio and P&L accuracy | Met (2026-10-11) | `web/e2e/portfolio.spec.ts` flow 6 (exact cost basis and realized P&L); `packages/sdk/test/pnl.test.ts`, `web/src/lib/positions-view.test.ts` |
| Frontend: settlement display and redeem flow | Met | `web/e2e/portfolio.spec.ts`, `web/e2e/admin.spec.ts` |
| Clear documentation, reproducible deployment | Met | `README.md`, `ARCHITECTURE.md`, `docs/deployment.md`, `docs/ONBOARDING.md` |

### §8 Deliverables

| Deliverable | Status | Evidence |
|---|---|---|
| Source code | Met | program, SDK, worker, web |
| Technical documentation | Met | `ARCHITECTURE.md`, `docs/architecture.md`, `DECISIONS.md`, `docs/risks-and-limitations.md`, `KEY_METRICS.md`, `SCALING.md` |
| Deployment guide, one-command setup | Met | `docs/deployment.md`, `make dev` |
| Test results | Met (2026-10-11) | `docs/test-results.md` |
| Demo video | Met | `design/demo/meridian-demo-narrated.mp4` (5 min 53 s), `docs/demo-script.md` |
| AI usage log | Met | `AI_USAGE.md`, written as the work happened |

### §9 Traceability

Commits from the first weeks carry `FR-n:` prefixes; most later commits reference spec-kit task ids
(`T0nn`) or describe the change in plain words instead, so a reviewer should not expect the PRD's
literal convention across the whole history. Requirement traceability runs through
`specs/001-binary-outcome-markets/` (spec, plan, tasks with FR references), `DECISIONS.md`, and this
file. From 2026-10-11 commits that advance a requirement name it again.
