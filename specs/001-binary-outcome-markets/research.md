# Research: Binary Stock Outcome Markets

**Date**: 2026-10-06 | **Feeds**: `plan.md` Technical Context

Every entry below was checked on 2026-10-06 by RPC, registry API or document read, not recalled.
Settled decisions from `DECISIONS.md` are referenced, not re-argued.

## R1. Toolchain pins (DECISIONS §7)

**Decision**: Rust 1.89, Anchor 1.2.1, Agave CLI 3.1.14, Node 22 LTS, pnpm 10, in a pinned
Dockerfile plus `.devcontainer`. First implementation task is to build the image and prove the triple
compiles a hello-world program; if 1.2.1 misbehaves, fall back to 1.2.0 (released 2026-09-04).

**Rationale**: `anchor-lang` 1.2.1 was published 2026-10-06 and declares `rust-version = 1.89`; it
depends on the Solana v3 crate family (`solana-account-info ^3.1`, `solana-cpi ^3.0`), so the matching
CLI is Agave 3.1.x. `anzaxyz/agave:v3.1.14` is the current `stable` Docker tag and
`release.anza.xyz/v3.1.14/install` is live. The `solanafoundation/anchor` image stops at v1.0.2, so we
build our own image, which §7 already assumed.

**Alternatives**: Agave 4.3.0 (latest GitHub release, 2026-09-18) needs Anchor's unreleased
`solana-v4` feature; rejected. Host install rejected by §7.

## R2. TypeScript client packages

**Decision**: `@anchor-lang/core` 1.2.1 for IDL clients (program tests, service, web),
`@solana/web3.js` 1.99 as the transport, `@solana/wallet-adapter-react` 0.15.40 in the web app.

**Rationale**: Anchor's TypeScript package moved from `@coral-xyz/anchor` (stops at 0.32.1) to
`@anchor-lang/core` at 1.x; its `latest` tag is 1.2.1 and it depends on `@solana/web3.js ^1.69`.
Wallet adapter peers on `web3.js ^1.99`. `@solana/kit` 8.x is the newer transport but wallet adapter
does not peer on it; mixing both would double the dependency surface for no feature.

**Alternatives**: `@solana/kit` only — rejected until wallet adapter supports it.

## R3. Program tests with clock control

**Decision**: `anchor-litesvm` 0.2.1 + `litesvm` for program unit tests, run by Mocha/TS inside the
container. Integration lifecycle runs against `solana-test-validator` and then against devnet.

**Rationale**: FR-031 (refuse settle before close) and FR-033 (override only after ≥1 h) need the
clock warped forward in a test. LiteSVM exposes `setClock`; the test validator does not without
restarting. `anchor-litesvm` pins `@coral-xyz/anchor ^0.31`, which is only a dev dependency of the test
package and does not touch the shipped client.

**Alternatives**: `solana-bankrun` 0.4.0 (older, same idea); mocking time in the program with a
feature flag — rejected because it leaves test-only code in the money path.

## R4. Pyth: feeds, endpoint, auth, program (DECISIONS §4)

**Decision**: Use the `Equity.US.<SYM>/USD` feeds. Hermes base URL `https://pyth.dourolabs.app/hermes`,
header `Authorization: Bearer $PYTH_API_KEY`. Receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`
on devnet (executable, upgradeable loader; verified). Rust: `pyth-solana-receiver-sdk` 2.0.0, which
requires `anchor-lang ^1.0.2` and so is compatible with 1.2.1.

| Ticker | Feed ID (`Equity.US.*/USD`, regular session) |
|---|---|
| AAPL | `49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` |
| AMZN | `b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a` |
| GOOGL | `5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6` |
| META | `78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe` |
| MSFT | `d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1` |
| NVDA | `b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593` |
| TSLA | `16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1` |

**Rationale**: The spike recorded the `Equity.Index.*` IDs, which Hermes describes as "PYTH PRICE IN
USD FOR AAPL 24/7" — a synthetic 24/7 index, wrong for a 4:00 PM close. The `Equity.US.*` feeds carry
`schedule: America/New_York;0930-1600,…` with NYSE holidays, which is the regular session. This closes
the feed-variant risk in the handoff. The feed-list endpoint is public (HTTP 200 unauthenticated), the
price endpoints are not (401), matching the spike.

**Consequence for timing**: Pyth's market-hours page says US equity feeds are "available 9:30 AM to
4 PM ET". After the bell the feed stops advancing, so `publish_time` sits at roughly 16:00:00. With the
brief's 5-minute staleness bound, **settlement must land between 16:00 and 16:05**. The settlement
job therefore starts at 16:00:30 ET, not 16:05, and the 30-second retry cadence gives nine attempts
inside the window. If the window is missed the 15-minute retry loop keeps failing by design, the
operator is alerted, and the override opens at 17:00. The day-one probe (R5) measures the real
post-close `publish_time` behaviour and may relax this.

**Alternatives**: `Equity.US.<SYM>.PRE_AFTER/USD` extended-hours variants exist for some tickers;
they would keep updating after 16:00 but report after-hours prints, not the close. Rejected.

## R5. Pyth token-day probe (one task, run when the key arrives)

1. `GET /v2/updates/price/latest?ids[]=<Equity.US.AAPL>` with the bearer header; record HTTP code,
   `price`, `conf`, `expo`, `publish_time`. Confirms the key and the auth shape.
2. Repeat at 16:01 ET and 16:10 ET on a trading day; record `publish_time` drift after the bell.
   Sets `min_publish_offset` and confirms the settlement window in R4.
3. Post the update to the devnet receiver with `@pythnetwork/pyth-solana-receiver` (service side only;
   it pins `@coral-xyz/anchor ^0.29`, isolated in the service package) and read the resulting
   `PriceUpdateV2` with `pyth-solana-receiver-sdk` in a LiteSVM test. Confirms layout and
   `VerificationLevel::Full`.
4. Compare the Pyth close with Nasdaq's `lastSalePrice` after the bell; sets the mock's `conf` floor.

Until then the `MockPyth` provider carries every test. None of the four items changes the program
interface; they set config values.

## R6. Settlement asset: Circle devnet USDC

**Decision**: Default collateral mint is Circle's devnet USDC
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (verified by RPC: SPL Token program, 6 decimals,
Circle mint authority). Funded from `faucet.circle.com` (reachable). Local-validator and LiteSVM tests
use a mint the test creates, because they need unlimited supply and no faucet.

**Rationale**: The portal brief lists "USDC integration" as its own item. A reviewer with a Phantom
wallet on devnet already holds this mint. The program takes the mint from `Config`, so the switch is a
config value.

**Alternatives**: Our own devnet mint everywhere — simpler faucet story but reads as a stablecoin
stand-in rather than USDC integration.

## R7. Order book representation (DECISIONS §6)

**Decision**: One `Book` account per market, owned by the program: a fixed header plus two
fixed-capacity arrays (bids, asks) of 64-byte `Order` records, capacity chosen at creation
(16 demo-scale, 128 default) so rent scales with the configuration. Price is micro-USDC per Yes token
in `1..=999_999`; quantity is whole tokens (6-decimal mints, one token = one dollar of claim). Matching
is price-time priority with a hard cap of 8 fills per transaction; a taker that would need more fills
takes 8 and either rests the remainder (limit) or receives it back (market/IOC).

**Rationale**: Bounded compute per transaction is a constitution constraint. 8 fills × (two token
transfers + bookkeeping) stays well under the 200k CU default without requesting more. Variable
capacity is done with a byte region cast via `bytemuck` rather than Anchor `zero_copy` structs, which
need compile-time sizes.

**Rent (estimates, to be verified by `getMinimumBalanceForRentExemption` in the setup script)**:

| Config | Book bytes | Rent per market (book + market + 2 mints + vault + 2 escrows) | Markets/day | SOL/day |
|---|---|---|---|---|
| Demo scale: 7 tickers × 5–7 strikes, cap 16 | ~2.2 KB | ~0.027 SOL | ~45 | ~1.25 |
| Default: 7 tickers × 5–7 strikes, cap 128 | ~16.5 KB | ~0.13 SOL | ~45 | ~5.8 |

Demo scale changes only the book capacity, never the number of tickers or strikes, so it meets every
PRD requirement (FR-001, SC-003) and still fits one ~2 SOL airdrop with margin. Rent is recycled: books and markets close after
settlement once escrows and vault are empty.

**Alternatives**: Linked-list or critbit book — more compute-efficient at scale, more code, not
needed at ≤128 orders per side.

## R8. The four trade paths as instructions

**Decision**:

| User action | Instruction | Atomic composition |
|---|---|---|
| Buy Yes (market/limit) | `place_order(Bid, …)` | take asks, rest remainder if limit |
| Sell Yes (market/limit) | `place_order(Ask, …)` | take bids, rest remainder if limit |
| Buy No (market) | `buy_no_market(qty, min_yes_price)` | mint `qty` pairs, sell Yes IOC into bids, **redeem any unfilled pairs**, user keeps only No |
| Buy No (limit) | `buy_no_limit(qty, price)` | mint `qty` pairs, post Yes ask; user holds both until it fills (FR-014) |
| Sell No (market) | `sell_no_market(qty, max_yes_price)` | buy Yes IOC from asks, redeem pairs, user receives `qty × (1 − p)` |
| Sell No (limit) | `place_order(Bid, …)` | UI frames it; on fill the user holds a pair and redeems |

**Rationale**: FR-013 requires Buy No market to be one approval and never leave an unintended
position. Redeeming unfilled pairs inside the same instruction is what makes the second half true.

## R9. Time and the trading day

**Decision**: The service computes `close_ts` (16:00:00 America/New_York as a Unix timestamp,
DST-aware via Luxon) for each trading day and passes it to `create_market`; the program stores it and
compares against `Clock::unix_timestamp`. The program also stores `trading_day` as `YYYYMMDD` for PDA
seeds and display. Holidays come from Pyth's published schedule string for the feed (R4), parsed by the
service; a fixed NYSE holiday list in config is the fallback.

**Rationale**: The chain has no timezone. Putting the ET conversion in one place off chain and the
comparison on chain keeps FR-031/FR-033 enforceable by the program without a DST table on chain.

## R10. Real-time book updates (FR-011)

**Decision**: The web app subscribes to each visible `Book` account over the RPC websocket
(`onAccountChange`) and decodes client-side. No backend push service.

**Rationale**: Account subscriptions deliver within a slot (~400 ms), inside SC-008's one second.
Devnet public RPC rate-limits websockets; the `.env.example` names an RPC URL variable so a Helius or
Triton devnet endpoint can be substituted.

## R11. Fills, positions, P&L (FR-027, FR-028)

**Decision**: The program emits an Anchor `Fill` event per match and `Settled`, `Redeemed`,
`Minted` events. The web app reconstructs positions and realized P&L for the connected wallet from
events via `getSignaturesForAddress` on the wallet plus log parsing, cached in the browser. The
History page is this event stream.

**Rationale**: No database, nothing custodial, nothing to deploy. Devnet history is bounded (days).

**Alternatives**: An indexer service writing Postgres — more infrastructure than the demo justifies;
can be added behind the same event contract.

## R12. Mock provider price sources

**Decision**: Finnhub `/quote` (free key, 60/min) is the mock publisher's price; Nasdaq
`api.nasdaq.com/api/quote/<SYM>/info` (keyless, verified live today, `isRealTime: true`) is the
cross-check. `conf = max(|finnhub − nasdaq|, $0.01)`. If either source fails, the publisher does not
write, so the on-chain price goes stale and the guard trips — fail closed.

**Rationale**: Principle IV forbids a hardcoded confidence; disagreement between two independent
reads is a real measure, and the spike showed they agree to the cent on a normal close.

## R13. Operator alerting (FR-032)

**Decision**: After the retry window the service posts to `ALERT_WEBHOOK_URL` (Slack/Discord
incoming-webhook JSON) and logs at error level. The Markets and Trade pages show the contract as
"Awaiting settlement" with no implementation detail. The admin page is not a product page and may show
the guard that tripped.

## R14. Frontend stack

**Decision**: Next.js 16.4 (App Router), React, TypeScript, Tailwind, `@solana/wallet-adapter-react`
with Phantom and Solflare adapters, Vitest for the intent-to-instruction translation layer, Playwright
for five smoke flows using a test wallet injected into the page.

**Rationale**: Mirrors the partner stack (Principle II). The translation layer (four buttons → book
operations, position-aware gating) is where defects would be expensive, so it gets unit tests.

## Resolved clarifications

| Item | Resolution |
|---|---|
| Which Pyth feed carries the 4 PM close | `Equity.US.*/USD` (R4) |
| Settle-read mechanism | Read a `PriceUpdateV2` our service posted to Pyth's receiver; for the mock, read our own PDA. Payload verification in our program is not needed with Pyth: the receiver verifies Wormhole signatures |
| Demo-scale configuration | full seven-ticker ladder, book cap 16, ~1.25 SOL (R7) |
| USDC mint | Circle devnet USDC by default, local mint in tests (R6) |
| Override delay | 3600 s default, config value, LiteSVM-tested (R3) |
| Confidence band | 25 bps: sources agree to the cent on a normal close (R12), so 1% would never trip; revisited with real Pyth `conf` on the probe day |
| Settlement start time | 16:00:30 ET because Pyth equity feeds stop at the bell (R4) |

No `NEEDS CLARIFICATION` remains in the plan.
