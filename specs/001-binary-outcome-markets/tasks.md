# Tasks: Binary Stock Outcome Markets

**Input**: Design documents from `specs/001-binary-outcome-markets/` (plan.md, research.md,
data-model.md, contracts/, quickstart.md, spec.md)

**Tests**: Requested. PRD §7 names program, integration and frontend tests as graded deliverables, so
test tasks are included and sit before the implementation they cover.

**Organization**: Phases follow plan.md "Phase ordering". Phase 1 (container) and Phase 2
(foundations) carry no story label. Product phases carry the user story they deliver. The Pyth
token-day probe is its own phase and can run whenever `PYTH_API_KEY` exists.

**Rules that apply to every task**: integers only on the money path; no implementation commentary
in product UI (`/`, `/markets`, `/trade`, `/portfolio`, `/history`); nothing installed on the host,
every command runs in the container; a decision made while implementing is written to
`DECISIONS.md` once, when made; commits reference the FR they advance.

## Format: `[ID] [P?] [Story] Description with file path`

---

## Phase 1: Container and skeleton (DECISIONS §7) — gate: `make dev` green

**Purpose**: The canonical toolchain. No product code until T012 passes on a clean machine.

- [ ] T001 Create `Dockerfile` from `rust:1.89-bookworm`: install Agave CLI 3.1.14 via `release.anza.xyz/v3.1.14/install`, Anchor CLI 1.2.1 via `cargo install --git https://github.com/solana-foundation/anchor --tag v1.2.1 anchor-cli`, Node 22 LTS and pnpm 10 via corepack; non-root user; `WORKDIR /work`
- [ ] T002 Create `compose.yml` with service `dev`: build from `Dockerfile`, mount repo at `/work`, named volumes `cargo-registry` → `/usr/local/cargo/registry` and `target` → `/work/target`, keys dir mounted read-only at `/run/keys`, ports 3000 and 8899/8900, `env_file: .env`
- [ ] T003 [P] Create `.devcontainer/devcontainer.json` pointing at `compose.yml` service `dev` with rust-analyzer and ESLint extensions
- [ ] T004 [P] Create `Makefile` targets per quickstart.md: `dev`, `build`, `test-program`, `lifecycle` (CLUSTER=localnet|devnet, DEMO_SCALE), `deploy`, `jobs`, `web`, `test-web`, `shell`; every target runs through `docker compose run --rm dev`
- [ ] T005 [P] Create `.env.example` with every variable in `contracts/oracle-provider.md` (including `AUTOMATION_STATUS_PORT` and the `NEXT_PUBLIC_*` web variables) and a one-line comment each; confirm `.gitignore` excludes `.env` and keypairs
- [ ] T006 Initialise Anchor workspace: `Anchor.toml` (cluster devnet by default, `[programs.localnet]` and `[programs.devnet]`, `test = "pnpm --filter tests run program"`), root `Cargo.toml` workspace with `programs/meridian`, `programs/meridian/Cargo.toml` pinning `anchor-lang = "1.2.1"`, `anchor-spl = "1.2.1"`, `pyth-solana-receiver-sdk = "2.0.0"`, `bytemuck`
- [ ] T007 Create hello-world program `programs/meridian/src/lib.rs` with `declare_id!` and a single `ping` instruction so the build pipeline can be proven before product code
- [ ] T008 Initialise pnpm workspace: root `package.json`, `pnpm-workspace.yaml` (`packages/sdk`, `services/automation`, `web`, `tests`), `tsconfig.base.json`; pin `@anchor-lang/core@1.2.1`, `@solana/web3.js@1.99`, `typescript@5`
- [ ] T009 Create `tests/package.json` with `anchor-litesvm@0.2.1`, `litesvm`, `mocha`, `chai`, `ts-node`; add `tests/program/ping.test.ts` that loads the built `.so` into LiteSVM and calls `ping`
- [ ] T010 [P] Create `packages/sdk/package.json` and `packages/sdk/src/index.ts` exporting the program ID and a `loadIdl()` helper reading `target/idl/meridian.json`
- [ ] T011 [P] Create `services/automation/package.json` and `web/package.json` (Next.js 16.4, React, Tailwind, `@solana/wallet-adapter-react@0.15.40`, wallet-adapter-wallets for Phantom and Solflare) with placeholder entry points so `pnpm install` resolves the whole workspace
- [ ] T012 Run `make dev` on a clean checkout: image builds, `anchor build` succeeds, `tests/program/ping.test.ts` passes, `solana-test-validator` starts, web placeholder serves on :3000. Record the verified version triple in `README.md` "Toolchain" section and, if any pin had to move, in `DECISIONS.md` §7

**Checkpoint**: `make dev` green from nothing but Docker. Only now does product code start.

---

## Phase 2: Foundations (no story label)

**Purpose**: Accounts, errors, events, math and SDK pieces every story needs.

- [ ] T013 Create `programs/meridian/src/errors.rs` with the error enum from `contracts/program-instructions.md` (Paused, MarketSettled, MarketNotSettled, BeforeClose, AlreadySettled, OverrideTooEarly, Unauthorized, PublisherNotAllowed, OracleOwnerMismatch, OracleFeedMismatch, OracleStale, OracleTooOld, OracleLowConfidence, OracleBadPrice, OracleVerificationLevel, BookFull, PriceOutOfRange, ZeroQuantity, WrongSide, InsufficientFill, NotEmpty, InvariantViolated)
- [ ] T014 [P] Create `programs/meridian/src/events.rs` with every event in data-model.md "Events" with the listed fields
- [ ] T015 [P] Create `programs/meridian/src/math.rs`: `ONE_USDC: u64 = 1_000_000`, `checked_mul_div`, `normalize_price(price: i64, expo: i32) -> Result<u64>` to micro-USD (refuse ≤ 0, overflow), `conf_within_bps(price, conf, bps) -> bool`; unit tests in the same file
- [ ] T016 Create `programs/meridian/src/state/config.rs` with `Config` exactly as data-model.md (admin, paused, usdc_mint, `OracleProvider { MockPyth, PythReceiver }`, oracle_program, publishers `[Pubkey; 4]` + len, max_staleness_secs, max_conf_bps, min_publish_offset_secs, override_delay_secs, `[TickerInfo; 7]` with `symbol: [u8; 8]`, `feed_id: [u8; 32]`, `enabled`, default_book_capacity, bump) and `validate()` enforcing "override_delay_secs ≥ 3600; max_staleness_secs ≤ 300; publishers.len ≥ 1 when provider is MockPyth; oracle_program must equal the program ID when provider is MockPyth"
- [ ] T017 [P] Create `programs/meridian/src/state/market.rs` with `Market` as data-model.md (ticker, strike, trading_day, close_ts, `MarketState { Open, Settled }`, `Outcome { Unset, Yes, No }`, settlement_price, settled_at, settled_by_override, yes_mint, no_mint, vault, book, pairs_outstanding, bump, vault_bump) and seeds `["market", ticker, trading_day_le, strike_le]`
- [ ] T018 Implement `initialize_config` and `update_config` in `programs/meridian/src/instructions/config.rs` (admin signer; `update_config` may change provider, oracle_program, publishers, thresholds, tickers, default capacity; always calls `validate()`); wire in `lib.rs`, remove `ping`
- [ ] T019 Create `programs/meridian/src/state/book.rs` (layout only): `BookHeader` (market, capacity u16, bid_count u16, ask_count u16, next_order_id u64, next_seq u64, usdc_escrow, yes_escrow) and `Order` (id u64, owner Pubkey, price u64, remaining u64, seq u64; exactly 64 bytes, `bytemuck::Pod`), `book_space(capacity) = 8 + size_of::<BookHeader>() + 2 × capacity × 64`, and `BookHeader::init(...)`; slice helpers and sorting invariants come in T051
- [ ] T020 Implement `create_market` and `add_strike` in `programs/meridian/src/instructions/create_market.rs`: admin signer, ticker enabled, `close_ts > now`, creates Market PDA, Yes and No SPL mints (6 decimals, authority = market PDA), USDC vault token account owned by market PDA, and the Book account sized by `book_space(capacity)` with `BookHeader::init` written (T019) plus `usdc_escrow` and `yes_escrow` token accounts; emits `MarketCreated`. `add_strike` is the same handler under its own name
- [ ] T021 Write `tests/program/helpers.ts`: LiteSVM bootstrap (load program, create test USDC mint with 6 decimals, fund wallets, `warpTo(unixTs)` via `setClock`, helpers to call each instruction with `@anchor-lang/core`) and `tests/program/config.test.ts` covering `validate()` rejections and admin-only `update_config`
- [ ] T022 [P] Create `packages/sdk/src/pda.ts` (config, market, book, mock_price, vault, escrows) and `packages/sdk/src/types.ts` (micro-unit branded types, Ticker enum with the seven symbols and the `Equity.US` feed IDs from research.md R4)
- [ ] T023 [P] Create `services/automation/src/log.ts` (JSON lines per `contracts/automation.md`) and `services/automation/src/config.ts` reading every env var from `.env.example` with zod validation, refusing `ORACLE_PROVIDER=mock` unless `SOLANA_CLUSTER` is `devnet` or `localnet`

**Checkpoint**: Config and markets exist on LiteSVM; SDK can derive every address.

---

## Phase 3: User Story 1 — Binary payout is always exactly one dollar (P1) 🎯 MVP

**Goal**: Mint a pair for $1.00, redeem a pair for $1.00 any time, redeem the winner for $1.00 after
settlement, vault invariant enforced in code. (Settlement itself is Phase 4; this phase drives the
outcome directly in tests through a test-only path, then Phase 4 replaces it.)

**Independent Test**: quickstart.md Scenario 1 money-path cases: mint, redeem pair, redeem winning
on Yes/No/tie outcomes, invariant holds to the micro-unit, dust and partial redemption, redemption a
week later.

### Tests

- [ ] T024 [P] [US1] Write `tests/program/invariant.test.ts`: mint 1 pair → user holds 1 Yes + 1 No, vault +1_000_000; redeem pair before settlement → exactly 1_000_000 back, both burned; mint/redeem many random quantities and assert `vault.amount == pairs_outstanding × 1_000_000` after each; mint 0 refused with `ZeroQuantity`
- [ ] T025 [P] [US1] Write `tests/program/redeem_winning.test.ts`: on a settled market (set via `admin_settle_override` after warping ≥ 3600 s past close), Yes wins at 685 vs 680 → Yes redeems 1_000_000 per token, No redemption refused with `WrongSide`; tie 680 vs 680 → Yes wins; No wins at 675; redeem one week later succeeds; single-token redemption before settlement refused with `MarketNotSettled`; post-settlement vault equation `vault.amount == winning_supply × 1_000_000` holds after every redeem

### Implementation

- [ ] T026 [US1] Implement `mint_pair(qty)` in `programs/meridian/src/instructions/mint_pair.rs`: refuse when `config.paused` (`Paused`) or `market.state == Settled` (`MarketSettled`) or `qty == 0`; transfer `qty × ONE_USDC` from user to vault; mint `qty` Yes and `qty` No to the user's ATAs (create if needed); `pairs_outstanding += qty`; assert vault equation else `InvariantViolated`; emit `Minted`
- [ ] T027 [US1] Implement `redeem_pair(qty)` in `programs/meridian/src/instructions/redeem_pair.rs`: allowed in any state and while paused; burn `qty` of each; transfer `qty × ONE_USDC` from vault (PDA signer); `pairs_outstanding -= qty`; invariant assert; emit `PairRedeemed`
- [ ] T028 [US1] Implement `redeem_winning(side, qty)` in `programs/meridian/src/instructions/redeem_winning.rs`: require `Settled`; `side == outcome` else `WrongSide`; burn `qty` of the winning mint; pay `qty × ONE_USDC`; post-settlement invariant assert; emit `WinningRedeemed`
- [ ] T029 [US1] Implement `admin_settle_override(price)` in `programs/meridian/src/instructions/admin_settle_override.rs` (needed by T025 and FR-033): admin signer; `Open` else `AlreadySettled`; `now ≥ close_ts + max(config.override_delay_secs, 3600)` else `OverrideTooEarly`; `outcome = Yes if price ≥ strike else No`; `settled_by_override = true`; emit `Settled { by_override: true }`
- [ ] T030 [US1] Run T024 and T025 green; add `make test-program` to CI script `scripts/ci.sh`

**Checkpoint**: The dollar invariant is enforced on chain and proven. MVP for correctness.

---

## Phase 4: User Story 4 — Settlement is correct, timely, and happens once (P2)

**Goal**: Oracle provider interface with the mock arm, four guards, settle after close, idempotent,
pause/unpause; the settlement job with the retry window and alert.

**Independent Test**: quickstart.md Scenario 1 oracle cases plus Scenario 4 `job settle --once`.

### Tests

- [ ] T031 [P] [US4] Write `tests/program/oracle.test.ts`: with provider MockPyth, `mock_write_price` by an allowlisted key succeeds and by a stranger fails `PublisherNotAllowed`; settle with valid quote (publish_time = now, conf 1 cent) succeeds; stale (publish_time = now − 301) → `OracleStale`; too old (publish_time < close_ts − 60) → `OracleTooOld`; wide conf (> max_conf_bps) → `OracleLowConfidence`; price ≤ 0 → `OracleBadPrice`; wrong feed_id → `OracleFeedMismatch`; account not owned by program → `OracleOwnerMismatch`
- [ ] T032 [P] [US4] Write `tests/program/settle.test.ts`: settle before `close_ts` → `BeforeClose`; settle at `close_ts` with good quote → outcome written, `Settled` event; second settle → `AlreadySettled`, vault untouched; at-or-above rule at above/equal/below; a market with zero mints still settles; `admin_settle_override` refused at `close_ts + 3599` and accepted at `close_ts + 3600`; override on a settled market → `AlreadySettled`; non-admin override → `Unauthorized`
- [ ] T033 [P] [US4] Write `tests/program/pause.test.ts`: `pause` by admin; `mint_pair` → `Paused`; `place_order` → `Paused` (stub until Phase 5, mark pending); `redeem_pair` and `redeem_winning` succeed while paused; non-admin pause → `Unauthorized`; `unpause` restores minting
- [ ] T034 [P] [US4] Write `services/automation/test/settle.test.ts` (Vitest, fake timers, mocked program client): guard failure → retries every 30 s → after 15 min calls `alert()` once and stops; `AlreadySettled` → treated as success, no alert; success on third attempt → no alert

### Implementation

- [ ] T035 [US4] Create `programs/meridian/src/state/mock_price.rs` with `MockPriceUpdate` (feed_id, price i64, conf u64, expo i32, publish_time i64, publisher, write_slot) seeds `["mock_price", feed_id]`, and `mock_write_price` in `programs/meridian/src/instructions/mock_write_price.rs` (provider must be MockPyth; signer in `config.publishers`; `init_if_needed`; records publisher and slot)
- [ ] T036 [US4] Create `programs/meridian/src/oracle/mod.rs` with `OracleQuote` and `read_quote(config, ticker, price_account, market, clock)` applying, in order, owner/parse/attestation per provider then the four guards exactly as `contracts/oracle-provider.md` (BadPrice → Stale → TooOld → LowConfidence), each with its own error
- [ ] T037 [P] [US4] Create `programs/meridian/src/oracle/mock.rs`: owner == program ID, PDA check, deserialize `MockPriceUpdate`, `feed_id` match, `publisher ∈ config.publishers` else `PublisherNotAllowed`
- [ ] T038 [P] [US4] Create `programs/meridian/src/oracle/pyth.rs`: owner == `config.oracle_program`, deserialize `PriceUpdateV2` with `pyth-solana-receiver-sdk`, `verification_level == Full` else `OracleVerificationLevel`, `feed_id` match; compiles and is unit-tested against a hand-built account in `tests/program/oracle_pyth_layout.test.ts` using the SDK's serializer (real-update test is Phase 10)
- [ ] T039 [US4] Implement `settle_market` in `programs/meridian/src/instructions/settle_market.rs`: anyone may call; `now ≥ close_ts` else `BeforeClose`; `Open` else `AlreadySettled`; `read_quote`; `outcome = Yes if price_micro ≥ strike`; write settlement_price, settled_at; emit `Settled`
- [ ] T040 [P] [US4] Implement `pause` and `unpause` in `programs/meridian/src/instructions/pause.rs` (admin signer, flips `config.paused`, emits events)
- [ ] T041 [US4] Run T031–T033 green
- [ ] T042 [P] [US4] Create `services/automation/src/sources/finnhub.ts` (`/quote` → `{ c, pc, t }`, key from env, 60/min budget) and `services/automation/src/sources/nasdaq.ts` (`/api/quote/<SYM>/info?assetclass=stocks` with browser User-Agent → `lastSalePrice`, `lastTradeTimestamp`); both return micro-USD integers, both throw on non-200
- [ ] T043 [US4] Create `services/automation/src/providers/PriceProvider.ts` (interface from `contracts/oracle-provider.md`) and `services/automation/src/providers/MockPythProvider.ts`: `publish` reads Finnhub + Nasdaq, `conf = max(|a − b|, 10_000)`, `expo = −6`, `publish_time = now`, signs `mock_write_price` with the publisher key, returns the PDA; `previousClose` returns Finnhub `pc` cross-checked within 0.5% of Nasdaq else throws; if either source fails, `publish` throws and writes nothing
- [ ] T044 [US4] Create `services/automation/src/calendar.ts`: `isTradingDay(date)`, `closeTs(tradingDay)` = 16:00:00 America/New_York via Luxon, `tradingDayOf(now)`, holidays parsed from the Pyth feed `schedule` string fetched from `/v2/price_feeds?asset_type=equity` (public) with a static NYSE list fallback; Vitest in `services/automation/test/calendar.test.ts` covering DST boundaries and a holiday
- [ ] T045 [US4] Create `services/automation/src/alert.ts` (POST `ALERT_WEBHOOK_URL` with the payload in `contracts/automation.md`, plus stderr) and `services/automation/src/jobs/settle.ts`: list `Open` markets with `close_ts ≤ now`, `provider.publish` once per ticker, `settle_market` per market, retry per ticker every 30 s until `start + 15 min`, then `alert` once; `AlreadySettled` is success; after every attempt update the in-memory `SettlementStatus` map (market, attempts, lastError, nextRetryAt, overrideAvailableAt); CLI flags `--day`, `--once`
- [ ] T046 [US4] Create `services/automation/src/jobs/publisher.ts` (mock only: every 60 s during 09:25–16:10 ET, `mock_write_price` per enabled ticker, skip on source failure) and `services/automation/src/index.ts` cron entry with `node-cron` in `America/New_York` for settle 16:00:30, publisher, and the morning/reclaim jobs added in Phases 6 and 9; `pnpm --filter automation run job <name>` dispatcher; `services/automation/src/status.ts` serving `GET /status` on `AUTOMATION_STATUS_PORT` (default 8787) with the `SettlementStatus` map as JSON per `contracts/automation.md`
- [ ] T047 [US4] Run T034 green; `job settle --once` against the local validator settles a synthetic market whose `close_ts` is in the past

**Checkpoint**: Settlement is guarded, idempotent, timed and automated with the mock provider.

---

## Phase 5: User Story 3 — Four ways to trade, one order book (P2)

**Goal**: In-program book, matching, cancel, the three composite No paths, and the Trade page.

**Independent Test**: quickstart.md Scenario 1 book cases, Scenario 2 all four paths, Scenario 5
flows 2 and 3.

### Tests

- [ ] T048 [P] [US3] Write `tests/program/book.test.ts`: place limit bid escrows `price × qty` USDC and appears sorted; place limit ask escrows `qty` Yes; crossing taker fills at maker price; equal-price orders fill in arrival order (FR-010); taker needing 9 fills gets 8 and the remainder rests (limit) or refunds (IOC); 17th resting order at capacity 16 → `BookFull`; cancel refunds exact escrow and works while paused and after settlement; price 0 and 1_000_000 → `PriceOutOfRange`; escrow sums equal book totals after every operation
- [ ] T049 [P] [US3] Write `tests/program/trade_paths.test.ts`: `buy_no_market(10, min 650_000)` against bids totalling 6 at 650_000 → user ends with exactly 6 No, 0 Yes, USDC spent `6 × 350_000`, `pairs_outstanding` +6 (4 unfilled pairs redeemed in the same tx); bids below `min_yes_price` untouched → `InsufficientFill` when zero fills; `buy_no_limit(5, 700_000)` → user holds 5 No and an ask for 5 Yes at 700_000; `sell_no_market(3, max 400_000)` with asks at 400_000 → user's No −3, USDC +`3 × 600_000`; all refused while paused or settled
- [ ] T050 [P] [US3] Write `packages/sdk/test/intent.test.ts` (Vitest): for each of buyYes/buyNo/sellYes/sellNo × market/limit the planned instruction and escrow amount; Buy No market cost `qty × (1 − bestBid)`; holding No → buyYes returns guidance "close No first"; holding Yes → buyNo returns guidance; LP pair (equal Yes and No from mint) is not gated; partial Buy No limit state renders as "No held, Yes resting"

### Implementation

- [ ] T051 [US3] Extend `programs/meridian/src/state/book.rs` with `BookRef<'a>` wrapping the raw account bytes with `bids()`/`asks()` slices via `bytemuck::cast_slice_mut`, `insert_sorted`, `remove_at`, invariants "bids sorted by (price desc, seq asc), asks by (price asc, seq asc)"
- [ ] T052 [US3] Create `programs/meridian/src/book/matching.rs`: `match_taker(book, side, price_limit, qty, max_fills = 8) -> Vec<FillPlan>` pure over the slices, price-time priority, partial maker fills; unit tests in Rust for ordering and the cap
- [ ] T053 [US3] Create `programs/meridian/src/book/escrow.rs`: transfers for bid USDC and ask Yes into/out of escrows with the market PDA as signer; helper that applies a `FillPlan` (maker receives, taker receives, emit `Fill`)
- [ ] T054 [US3] Implement `place_order(side, price, qty, tif)` in `programs/meridian/src/instructions/place_order.rs`: not paused, `Open`, `1 ≤ price ≤ 999_999`, `qty > 0`; escrow first; match up to 8 fills; remainder rests (Limit, `BookFull` if side full) or refunds (IOC); emit `OrderPlaced` and `Fill`s
- [ ] T055 [US3] Implement `cancel_order(order_id)` in `programs/meridian/src/instructions/cancel_order.rs`: owner signer; refund `price × remaining` or `remaining`; any state, paused or not; emit `OrderCancelled`
- [ ] T056 [US3] Implement `buy_no_market(qty, min_yes_price)` in `programs/meridian/src/instructions/buy_no_market.rs`: mint `qty` pairs (reuse T026 logic as an internal fn), sell Yes IOC into bids at or above `min_yes_price` (≤ 8 fills), redeem the unfilled pairs back to USDC in the same instruction, `InsufficientFill` if zero fills; invariant assert; user ends holding only No
- [ ] T057 [P] [US3] Implement `buy_no_limit(qty, price)` in `programs/meridian/src/instructions/buy_no_limit.rs`: mint `qty` pairs, post Yes ask at `price` (Limit, `BookFull` guard before minting)
- [ ] T058 [P] [US3] Implement `sell_no_market(qty, max_yes_price)` in `programs/meridian/src/instructions/sell_no_market.rs`: buy Yes IOC from asks at or below `max_yes_price`, redeem the filled pairs, `InsufficientFill` if zero fills; user receives `filled × (1 − p)` net
- [ ] T059 [US3] Un-pend the `place_order → Paused` case in T033; run T048, T049 green; check compute units of the 8-fill path with `solana logs` and record the number in `research.md` R7
- [ ] T060 [P] [US3] Create `packages/sdk/src/book.ts` (decode `BookHeader` + orders from account bytes, best bid/ask, depth from the Yes and the No perspective where No price = `1_000_000 − yes_price`) and `packages/sdk/src/intent.ts` per `contracts/frontend.md` "Translation layer"; run T050 green
- [ ] T061 [P] [US3] Create `web/src/lib/wallet.tsx` (wallet adapter provider with Phantom and Solflare, cluster and RPC from `NEXT_PUBLIC_*` env) and `web/src/lib/rpc.ts` (Connection, program client via `@anchor-lang/core`)
- [ ] T062 [US3] Create `web/src/hooks/useBook.ts`: `connection.onAccountChange(book)` subscription decoding via `packages/sdk/src/book.ts`, with initial fetch; `web/src/hooks/useMarkets.ts` listing today's `Market` accounts via `getProgramAccounts` with a `trading_day` memcmp
- [ ] T063 [US3] Create `web/src/components/BookView.tsx` (depth table toggling Yes/No perspective, implied opposite price `$1.00 − p`), `web/src/components/ContractCard.tsx` (strike, Yes/No prices, implied probability, payoff line "You pay $X. You win $1.00 if META closes at or above $680."), `web/src/components/Countdown.tsx` (to 16:00 ET)
- [ ] T064 [US3] Create `web/src/components/TradePanel.tsx`: four buttons, market/limit toggle, quantity and price inputs, uses `intent.ts`; position gating per `contracts/frontend.md` (replace Buy Yes with "Close your No position first" + one-tap Sell No, and symmetrically); Buy No limit shows "Pending" state; disabled with "Trading is paused" when `config.paused`; "Settlement pending" after close before outcome; no mechanic exposed in copy
- [ ] T065 [US3] Create `web/src/app/trade/[ticker]/page.tsx`: strike list for the ticker, selected strike's `BookView`, `TradePanel`, `Countdown`; settled strikes show settlement price and winning side with a Redeem button
- [ ] T066 [US3] Write `tests/web/trade.spec.ts` (Playwright, injected test wallet against the local validator): flow 2 (limit Buy Yes appears in book in a second page without reload) and flow 3 (Buy No market → wallet holds only No)

**Checkpoint**: All four trade paths work on chain and in the browser; book updates live.

---

## Phase 6: User Story 2 — Markets appear every morning without anyone touching them (P2)

**Goal**: Strike ladder and the morning job; Markets page.

**Independent Test**: `pnpm --filter automation run job morning --day <today>` against the local
validator creates the exact ladders from the spec examples; quickstart.md Scenario 4.

### Tests

- [ ] T067 [P] [US2] Write `packages/sdk/test/strikes.test.ts` (Vitest): META prev close 680_000_000 → [620, 640, 660, 680, 700, 720, 740] × 1e6; AAPL 230_000_000 → [210, 220, 230, 240, 250] × 1e6; rounding to nearest $10 with ties up; output sorted and deduplicated; integer-only arithmetic
- [ ] T068 [P] [US2] Write `services/automation/test/morning.test.ts` (Vitest, mocked provider and client): one ticker's `previousClose` throws → that ticker skipped and logged, other six created; per-transaction retry 3× with backoff; idempotent re-run on the same day creates nothing new (market PDA exists)

### Implementation

- [ ] T069 [US2] Create `packages/sdk/src/strikes.ts`: `strikeLadder(prevCloseMicro: bigint): bigint[]` implementing ±3/6/9% and the rounded close, `round10`, dedupe, sort; run T067 green
- [ ] T070 [US2] Create `services/automation/src/jobs/morning.ts`: for each enabled ticker `provider.previousClose` → `strikeLadder` → `create_market(ticker, strike, tradingDay, closeTs(tradingDay), capacity)` for every enabled ticker and every strike in the ladder regardless of scale; `DEMO_SCALE=1` only sets book capacity 16 (default 128) so a full seven-ticker day fits one faucet grant; skip existing PDAs; per-ticker isolation; `--day` flag; run T068 green; register in cron at 08:00 ET
- [ ] T071 [US2] Create `web/src/app/markets/page.tsx` with seven ticker cards (latest on-chain quote price, count of today's open contracts, time to close) linking to `/trade/[ticker]`
- [ ] T072 [US2] Create `web/src/app/page.tsx` (Landing): one-paragraph product explanation in end-user terms, the payoff line example, live prices for the seven tickers, connect-wallet button, link to Markets; browsing works without a wallet (FR-026 scenario 4)

**Checkpoint**: A trading day's markets appear from the job alone and are visible before open.

---

## Phase 7: User Story 7 — An operator can adjust the strike ladder, override, pause (P4)

**Goal**: Admin page and the remaining operator scenarios. The instructions already exist
(T020 `add_strike`, T029 override, T040 pause); this phase proves them end to end and exposes them.

**Independent Test**: spec US7 scenarios 1–6 on LiteSVM and in the admin page against the local
validator.

- [ ] T073 [P] [US7] Write `tests/program/admin.test.ts`: `add_strike` mid-session by admin creates a tradeable market that settles with the rest; by non-admin → `Unauthorized`; non-admin pause/unpause/override → `Unauthorized`; override before delay refused, after delay accepted and `settled_by_override == true`; settled outcome cannot be changed by a second override (`AlreadySettled`)
- [ ] T074 [US7] Create `web/src/hooks/useConfig.ts` and `web/src/app/admin/page.tsx` (not linked from product navigation; admin wallet only): config summary, pause/unpause buttons, add-strike form (ticker, strike, uses today's `close_ts`), unsettled-markets table showing attempts, last error and next retry from `GET /status` (`NEXT_PUBLIC_AUTOMATION_STATUS_URL`), falling back to "Status unavailable" when the service is unreachable, override form disabled until `close_ts + delay` with the enable time shown
- [ ] T075 [US7] Write `tests/web/admin.spec.ts` (Playwright): flow 5 (paused → trade controls disabled with "Trading is paused", Redeem still enabled on `/portfolio`)

**Checkpoint**: Every US7 scenario passes; the admin surface is separate from product pages.

---

## Phase 8: User Story 5 — A trader can see what they own and what they made (P3)

**Goal**: Portfolio and History from program events; redeem flows in the browser.

**Independent Test**: quickstart.md Scenario 5 flow 4 and a seeded fill history reproducing
hand-computed P&L.

- [ ] T076 [P] [US5] Create `packages/sdk/src/events.ts` (parse Anchor events from transaction logs for the program) and `packages/sdk/src/pnl.ts`: from `Minted`, `Fill`, `PairRedeemed`, `WinningRedeemed`, `Settled` build `{ market, yes_qty, no_qty, cost_basis_micro, realized_pnl_micro }`; No entry price = `1_000_000 − yes_fill_price`; Vitest `packages/sdk/test/pnl.test.ts` with a seeded history and hand-computed expectations
- [ ] T077 [US5] Create `web/src/hooks/usePositions.ts`: `getSignaturesForAddress(wallet)` → fetch parsed transactions → `events.ts` → `pnl.ts`, cached in `localStorage` by signature, refreshed on new `Fill`/`Settled` events
- [ ] T078 [US5] Create `web/src/app/portfolio/page.tsx`: USDC balance, open positions with cost basis, settled outcomes with settlement price, winning side and payout, realized P&L, Redeem winning and Redeem pair buttons (single approval each), resting orders with Cancel; pairs from minting shown as "Minted pair"
- [ ] T079 [P] [US5] Create `web/src/app/history/page.tsx`: chronological execution log for the wallet (mint, fill, cancel, settlement, redemption) with amounts and links to the explorer
- [ ] T080 [US5] Write `tests/web/portfolio.spec.ts` (Playwright): flow 1 (connect → balance shown) and flow 4 (settled market → Redeem → balance increases by payout)

**Checkpoint**: A trader sees what they hold and what they made, and can redeem from the browser.

---

## Phase 9: User Story 6 — A market maker can quote both sides (P3) + devnet scripts

**Goal**: Market-maker view, rent reclaim, and the reproducible devnet lifecycle (SC-006).

**Independent Test**: quickstart.md Scenarios 2 and 3.

- [ ] T081 [P] [US6] Implement `close_book` and `close_market` in `programs/meridian/src/instructions/close.rs`: admin; `Settled`; `bid_count == ask_count == 0` and escrows empty (`NotEmpty`); `close_market` additionally requires vault empty; lamports to admin; test in `tests/program/close.test.ts`
- [ ] T082 [US6] Add market-maker section to `web/src/app/portfolio/page.tsx` (or `web/src/components/MakerPanel.tsx`): mint pairs form, post resting Yes bids/asks across several strikes, exposure per strike (Yes − No), fills and P&L from `usePositions`
- [ ] T083 [US6] Create `services/automation/src/jobs/reclaim.ts` (20:00 ET: `close_book` then `close_market` for settled markets older than one day that are empty; best effort) and register in cron
- [ ] T084 [P] [US6] Create `scripts/rent-estimate.ts` (`getMinimumBalanceForRentExemption` for Market, Book at cap 16 and 128, mints, token accounts; prints per-market and per-day totals for both capacities) and `scripts/airdrop.ts` (request 2 SOL on devnet with a clear message on rate limit)
- [ ] T085 [US6] Create `scripts/deploy.ts` (`anchor build`, `anchor deploy --provider.cluster $CLUSTER`, write program ID to `Anchor.toml` and `packages/sdk/src/index.ts`) and `scripts/init-config.ts` (`initialize_config` with provider from env, admin and publisher keys from `/run/keys`, USDC mint from env or a freshly created local mint on localnet, seven tickers with `Equity.US` feed IDs, thresholds 300 s / 25 bps / 60 s / 3600 s, capacity 16 or 128 by `DEMO_SCALE`)
- [ ] T086 [US6] Create `scripts/lifecycle.ts`: print rent estimate; create a synthetic day (`close_ts = now + 90 s`) for all seven tickers with the full ladder at the configured book capacity; user A mints and quotes, user B takes Buy Yes, Buy No, Sell Yes, Sell No; publisher writes a price; wait for close; `job settle --once`; both redeem; assert vault == 0 and each user's USDC delta equals the hand-computed P&L; print program ID and all addresses
- [ ] T087 [US6] Write `tests/integration/lifecycle.test.ts` running `scripts/lifecycle.ts` against the local validator (Mocha) and the multi-user scenario from PRD §7 ("one user mints and quotes, another takes, and both redeem")
- [ ] T088 [US6] Run `make deploy CLUSTER=devnet` then `make lifecycle CLUSTER=devnet DEMO_SCALE=1` with Circle devnet USDC; record program ID, transaction signatures and SOL spent in `docs/deployment.md`; confirm the full day fits one ~2 SOL airdrop at capacity 16; if rent differs from research.md R7 by more than 20%, update R7 and DECISIONS §6

**Checkpoint**: A reviewer can reproduce create → mint → trade → settle → redeem on devnet unaided.

---

## Phase 10: Pyth token day (research R5) — runs any time `PYTH_API_KEY` exists

**Goal**: Switch the provider from the mock to Pyth's receiver with no program change.

**Independent Test**: quickstart.md Scenario 6.

- [ ] T089 Create `services/automation/src/sources/hermes.ts`: `GET {PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=<feed>&encoding=base64` with `Authorization: Bearer $PYTH_API_KEY`, parse `parsed[0].price` (`price`, `conf`, `expo`, `publish_time`) and `binary.data`; on 401/403/429 log the status and the pricing-page reminder, do not retry in a loop
- [ ] T090 Create `services/automation/src/probe/pyth.ts` implementing R5 steps 1–4: fetch AAPL `Equity.US`, print fields; if run between 16:00 and 16:15 ET also print `publish_time` drift; post the update to the devnet receiver with `@pythnetwork/pyth-solana-receiver`; print the `PriceUpdateV2` address; fetch Nasdaq close and print the difference. CLI `pnpm --filter automation run probe pyth`
- [ ] T091 Create `services/automation/src/providers/PythReceiverProvider.ts`: `publish` = Hermes fetch → post update → return account; `previousClose` = Hermes historical endpoint at the previous trading day's `closeTs` with Finnhub fallback
- [ ] T092 Write `tests/program/oracle_pyth_real.test.ts`: load the devnet `PriceUpdateV2` account bytes captured by T090 into LiteSVM under the receiver program ID, set config provider to PythReceiver and `oracle_program` to the receiver, warp clock to `publish_time + 10`, settle a market with `close_ts = publish_time − 30` → succeeds; warp to `publish_time + 301` → `OracleStale`
- [ ] T093 Record the probe results in `research.md` R4/R5 (actual post-close `publish_time` behaviour, whether `min_publish_offset_secs` 60 is right) and, if the settlement window or offset changes, in `DECISIONS.md` §4 as one dated note; run `scripts/init-config.ts --update --provider pyth` on devnet and rerun `make lifecycle CLUSTER=devnet DEMO_SCALE=1`

**Checkpoint**: Settlement price on devnet comes from a Pyth update; the mock remains the tested
fallback.

---

## Phase 11: Docs and polish

**Purpose**: Graded documentation deliverables and the cleanup pass.

- [ ] T094 [P] Rewrite `README.md`: what Meridian is, `make dev` one-command setup, toolchain triple, `.env.example` walkthrough, how to get devnet SOL and Circle USDC, how to run tests, links to the deployment guide and decision log
- [ ] T095 [P] Write `docs/deployment.md`: deploy to devnet step by step, demo-scale vs default, program ID and addresses from T088, how to run the jobs, how to switch provider to Pyth
- [ ] T096 [P] Write `docs/architecture.md`: program accounts and instructions (link contracts), the one-book-two-perspectives mechanic, the oracle provider interface and guards, automation schedule, frontend data flow from events
- [ ] T097 [P] Write `docs/risks-and-limitations.md`: mock provider trust model naming Pyth as the production path; no official closing-auction print on free sources; 16:00–16:05 settlement window; devnet faucet and RPC limits; bounded book capacity and 8-fill cap; browser-side P&L; no regulatory or compliance claims
- [ ] T098 Update `DECISIONS.md` for any decision taken during implementation that is not yet recorded (one entry each, dated when made) and add an `AI_USAGE.md` entry per implementation session with candor about where the model helped, misled, or was overridden
- [ ] T099 Product-copy sweep: grep `web/src/app/{page,markets,trade,portfolio,history}` for "mock", "provider", "Pyth", "simulated", "TODO", "stub", dead links and placeholder tabs; remove any found (global rule)
- [ ] T100 Run quickstart.md Scenarios 1–5 end to end on a clean clone with only Docker installed; fix anything that needs a manual step; record the run in `docs/deployment.md`
- [ ] T101 [P] Write `docs/demo-script.md`: the create → mint → trade → settle → redeem walkthrough for the demo video, using the `--day` synthetic-day path so it fits in one sitting

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1** gates everything: no product code before T012.
- **Phase 2** depends on Phase 1 and blocks every story.
- **Phase 3 (US1)** depends on Phase 2. It is the MVP for correctness.
- **Phase 4 (US4)** depends on Phase 3 (uses mint/redeem and the override from T029).
- **Phase 5 (US3)** depends on Phase 3 (mint/redeem internals) and T040 (pause) from Phase 4; the web
  tasks T061–T066 also need T022/T060.
- **Phase 6 (US2)** depends on Phase 2 (create_market) and T043–T044 (provider, calendar).
- **Phase 7 (US7)** depends on Phases 4 and 5.
- **Phase 8 (US5)** depends on Phase 5 (fills) and Phase 4 (settlement events).
- **Phase 9 (US6)** depends on Phases 3–6.
- **Phase 10** depends on T038 and T043 only; can run the day the key arrives, in parallel with 5–9.
- **Phase 11** depends on everything it documents; T094–T097 can be drafted early and finished last.

### Parallel opportunities

- Phase 1: T003, T004, T005 together; T010, T011 together after T008.
- Phase 2: T014, T015, T017 together; T022, T023 together.
- Phase 4: T031–T034 together; T037, T038, T040, T042 together.
- Phase 5: T048–T050 together; T057, T058 together; T060, T061 together; web tasks T062–T065 after
  T060/T061 while program tests finish.
- After Phase 5: Phases 6, 7, 8 can proceed in parallel; Phase 10 whenever the key exists.
- Phase 11: T094–T097 and T101 in parallel.

### Parallel example: Phase 4 tests

```bash
Task: "Write tests/program/oracle.test.ts (guards, allowlist)"
Task: "Write tests/program/settle.test.ts (before close, idempotent, override delay)"
Task: "Write tests/program/pause.test.ts"
Task: "Write services/automation/test/settle.test.ts (retry window, alert)"
```

---

## Implementation Strategy

### MVP first

1. Phase 1 → `make dev` green.
2. Phase 2 → config and markets.
3. Phase 3 → the dollar invariant proven on LiteSVM. Stop and validate.

### Incremental delivery

4. Phase 4 → guarded, automated settlement with the mock provider. Demo-able on the local validator.
5. Phase 5 → trading on chain and in the browser. First visual demo.
6. Phases 6–8 → morning automation, operator surface, portfolio.
7. Phase 9 → devnet lifecycle reproducible by a reviewer. This is the graded artefact.
8. Phase 10 → Pyth swap when the key lands; independent of 6–9.
9. Phase 11 → docs, sweep, clean-clone run.

### Scope cuts, if time runs short (record each in `DECISIONS.md`)

- Ship limit-only books (drop IOC and the market composites) and let the UI compose Buy No as two
  approvals, documented as a temporary cut against FR-013.
- Drop `/history` and fold the log into `/portfolio`.
- Playwright reduced to flows 2 and 4.

---

## Notes

- Task count: 101. Story split: US1 7, US4 17, US3 19, US2 6, US7 3, US5 5, US6 8; unlabeled
  (container, foundations, Pyth day, docs) 36.
- Every task names its file(s). Tests precede the implementation they cover in each phase.
- Commit after each task or logical group, message prefixed with the FR advanced.

---

## Waves (parallel execution plan, 2026-10-06)

Each agent in a wave owns a disjoint set of files and works in the same tree. The coordinator runs
the full build and test suite at the end of every wave, commits the wave as one change, and stops for
review before the next.

**Structural rules**: Wave 2 scaffolds `programs/meridian/src/lib.rs` with every instruction wired to
its own file and a stub body returning `NotImplemented`; after that nobody edits `lib.rs`,
`Cargo.toml` or `mod.rs`. Wave 3E owns the web layout and navigation shell. `tests/program/helpers.ts`
is Wave 2 only; later test agents add `tests/program/support/<area>.ts`. All dependencies are
installed in Waves 0–2; adding one later means stopping. `.env.example` and `Makefile` are Wave 0 only.
`services/automation/src/index.ts` is Wave 4C only.

| Wave | Agent | Tasks | Blocks on |
|---|---|---|---|
| 0 | single | T001–T012 (serial; gate `make dev` green) | — |
| 1 | A | T013, T014, T015 | 0 |
| 1 | B | T016, T017, T019 | 0 |
| 1 | C | T022, T023 | 0 |
| 2 | single | T018, T020, T021 + lib.rs scaffold of all remaining instruction stubs | 1 |
| 3 | A | T024, T026, T027 | 2 |
| 3 | B | T031, T032, T035, T036, T037, T038, T039, T040 | 2 |
| 3 | C | T042, T044 | 2 |
| 3 | D | T067, T069 | 2 |
| 3 | E | T061, T063 + web layout/nav shell | 2 |
| 4 | A | T025, T028, T029, T030, T033, T041 | 3A, 3B |
| 4 | B | T048, T051, T052, T053, T054, T055 | 3A |
| 4 | C | T034, T043, T045, T046, T068, T070 | 3B, 3C, 3D |
| 4 | D | T050, T060 | 1B |
| 4 | E | T062 (useMarkets, useConfig), T071, T072 | 3E |
| 4 | F | T076 | 1A |
| 5 | A | T049, T056, T057, T058, T059 | 4A, 4B |
| 5 | B | T081, T083 | 4A |
| 5 | C | T062 (useBook), T064, T065 | 4D, 4E |
| 5 | D | T077, T078, T079 | 4E, 4F |
| 5 | E | T073, T074 | 4A, 4C, 4E |
| 5 | F | T084, T085 | 4A |
| 6 | A | T086, T087 | 5A, 5B, 4C |
| 6 | B | T082 | 5D |
| 6 | C | T089, T090, T091, T092 (only if `PYTH_API_KEY` exists) | 3B, 4C |
| 6 | D | T094, T095, T096, T097, T101 (drafts) | 5 |
| 7 | A | T088 | 6A, 5F |
| 7 | B | T066, T075, T080 | 5C, 5D, 5E, 6A |
| 8 | single | T093, T098, T099, T100 (serial) | 7 |

Critical path: 0 → 2 → 3B → 4B → 5A → 6A → 7A. Peak concurrency: six agents (Waves 4 and 5).
