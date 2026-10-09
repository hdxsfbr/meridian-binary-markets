# Architecture

> This is the root architecture document. It replaces `docs/architecture.md` as the full
> technical reference. Addresses and transaction signatures live in `docs/deployment.md`, not
> here. For the *why* behind each major choice, see `DECISIONS.md`. For a from-scratch
> explanation of the domain, see `docs/ONBOARDING.md`.

## 1. System overview

```
                         user-signed txns
   ┌───────────────┐   ───────────────────▶   ┌───────────────────────┐
   │  web/         │                           │  programs/meridian    │
   │  Next.js + TS │   ◀───────────────────   │  Rust + Anchor, on     │
   │  6 pages      │   account reads (RPC/WS)  │  chain program        │
   └───────┬───────┘                           │  Config / Market /    │
           │                                    │  Book / mint/redeem/  │
           │ reads                              │  order book / settle │
           │ GET /events, /status               └───────────┬──────────┘
           ▼                                                  │
   ┌────────────────────┐    create_market / mock_write_price │ guarded
   │  services/         │    settle_market / close_*          │ read
   │  automation        │  ────────────────────────────────────┘
   │  (Node, cron jobs:  │
   │  morning, publisher,│         posts signed price update
   │  settle, extend,    │  ───────────────────────────────▶  ┌──────────────────┐
   │  reclaim; status +  │                                     │ Pyth receiver     │
   │  /events index      │  ◀─── fetches update ──────────────│ program (on chain)│
   │  server)            │                                     └──────────────────┘
   └──────────┬──────────┘                                              ▲
              │ fetches price updates                                   │ Hermes update
              ▼                                                          │
   ┌────────────────────┐                                      ┌──────────────────┐
   │ Pyth Hermes         │ ───────────────────────────────────▶│ (same update      │
   │ (push price feed)  │                                       │ posted above)     │
   └────────────────────┘                                      └──────────────────┘

   web/ also calls:
   - Helius RPC (devnet) for account reads/writes and websocket account-change subscriptions
   - a server route /api/prices (Hermes latest, 5 s cache)
   - a server route /api/price-history (Pyth Pro History API, 60 s cache) to seed the Trade chart

   Both web/ and services/automation run as two Railway services (see §7).
```

Three pieces, one program:

- **`programs/meridian`** (Rust/Anchor, on chain) — owns every rule that must not be broken:
  contract state, the collateral vault, minting, redemption, the order book and matching engine,
  and settlement. Enforced here because this is the only layer a malicious client cannot bypass.
- **`web/`** (Next.js/TypeScript) — wallet connection, order book display from both perspectives,
  the four trade buttons, portfolio and P&L, a trader-facing Docs tab, and an admin page. Six
  pages in all (Markets, Trade, Portfolio, History, Docs, Admin), dark theme, with a ticker tape
  in the nav. Translates user intent into transactions and derives state from events; holds
  nothing authoritative.
- **`services/automation`** (Node.js) — the scheduler: creates markets each morning, publishes a
  signed closing price, triggers settlement each afternoon, extends the strike ladder intraday,
  reclaims rent at night, and serves a `/status` and `/events` endpoint. Cannot move user funds;
  the one real power it holds is that its publisher key is on the on-chain allowlist, so it is
  the thing that tells the system what the closing price was.

## 2. Why Solana/Anchor, on-chain CLOB, Pyth

These three choices are explained in full, with trade-offs, in `DECISIONS.md` §3, §4 and §6.
Summary:

- **Solana + Anchor, not an EVM L2** (`DECISIONS.md` §3). The brief names Solana as recommended,
  requires Rust, and requires a devnet deployment to pass; it also warns that EVM chains "may
  introduce latency challenges for on-chain order book performance." Trade-off: Anchor's account
  model is a steeper ramp than Solidity, and devnet-only means no mainnet-grade liquidity to demo
  against; accepted because sub-second finality comes free and the choice is directly legible to
  a Solana-focused reviewer.
- **A minimal in-program CLOB, not an integration with Phoenix** (`DECISIONS.md` §6, resolved by
  spike). Phoenix is live on devnet, but its market accounts run 84,944-232,544 bytes; Meridian
  needs about 45 fresh markets every trading day, which the spike computed at 19-53 SOL/day in
  rent alone against a devnet faucet that caps a single request at roughly 2 SOL. Phoenix also
  gates resting orders behind a maker "Seat" granted by the market authority, which does not fit
  one-transaction, one-approval market orders (FR-013). Trade-off: Meridian now owns a matching
  engine, the single largest piece of bespoke risk in the project; accepted because it is the
  path the brief credits as showing deeper understanding, keeps the system devnet-reproducible,
  and lets books close and reclaim rent at settlement, which Phoenix's lifecycle does not offer.
- **Pyth behind a provider interface, mocked until the equity entitlement landed, real since**
  (`DECISIONS.md` §4). The brief requires an oracle that can supply the previous close and the
  4:00 PM close, readable on-chain, with staleness and confidence checks, without naming a
  vendor. The program calls one function, `read_quote`, that returns a price, a publish time and
  a confidence measure, or refuses; it does not know which vendor answered. The target vendor is
  Pyth: `pyth-solana-receiver-sdk` is a maintained crate, its devnet receiver program is
  permissionless, and its price account natively carries a confidence interval. Until the equity
  entitlement arrived, the default provider was `MockPyth` — our own automation service, reading
  two free sources (Finnhub, Nasdaq) and signing a price in the same account shape a real Pyth
  update would carry, so every guard is exercised identically either way. Trade-off: until the
  switch, settlement acted on a price our own service chose and signed, a materially weaker trust
  model than Pyth's independent network (disclosed in `docs/risks-and-limitations.md` §1). The
  entitlement landed 2026-10-08 and the live config has used `pythReceiver` since
  (`docs/deployment.md` §2); switching providers is one `update_config` call, not a program
  change.

## 3. On-chain design

Full field-level detail: `specs/001-binary-outcome-markets/data-model.md`. Full instruction
account lists: `specs/001-binary-outcome-markets/contracts/program-instructions.md`.

### Accounts

| Account | Seeds | Size | Notes |
| --- | --- | --- | --- |
| `Config` | `["config"]` | 539 bytes incl. 8-byte discriminator | Singleton: admin authority, pause flag, oracle provider + program, publisher allowlist, guard thresholds, listed tickers, default book capacity |
| `Market` | `["market", ticker, trading_day u32 LE, strike u64 LE]` | 196 bytes | One per ticker/strike/trading-day: state, outcome, settlement price, the two SPL mints, the vault, a pointer to its `Book` |
| `Book` | `["book", market]` | `8 + 120 + 2*capacity*64` — 2,176 bytes at capacity 16, 16,512 bytes at capacity 128 | Raw account, not an Anchor `#[account]` (its own 8-byte discriminator is the literal `b"MERIBOOK"`); fixed header plus variable-capacity bid/ask arrays of price-time-ordered orders. Verified directly against `programs/meridian/src/state/book.rs`'s own `book_space()` and its unit tests (`book_space_for_demo_scale_capacity_16`, `book_space_for_default_capacity_128`) |
| `MockPriceUpdate` | `["mock_price", feed_id]` | — | One per feed ID, mock-provider only; mirrors the fields a real Pyth `PriceUpdateV2` would carry |

Other PDAs seeded by market: `yes_mint`, `no_mint`, `vault`, `escrow_usdc`, `escrow_yes`.

**How to refresh:** `grep -n "pub struct\|book_space" programs/meridian/src/state/*.rs`, or run
`pnpm --filter @meridian/scripts run rent-estimate` inside the dev container for live
`getMinimumBalanceForRentExemption` figures per account type.

### Instructions

Every row below is one `pub fn` inside `#[program] mod meridian` in
`programs/meridian/src/lib.rs` — verified today with
`grep -n "pub fn" programs/meridian/src/lib.rs` inside the `#[program]` module, which returns
20 functions across 16 instruction files under `programs/meridian/src/instructions/`
(`admin_settle_override`, `buy_no_limit`, `buy_no_market`, `cancel_order`, `close` [`close_book` +
`close_market`], `config` [`initialize_config` + `update_config`], `create_book`, `create_market`
[+ `add_strike`], `mint_pair`, `mock_write_price`, `pause` [+ `unpause`], `place_order`,
`redeem_pair`, `redeem_winning`, `sell_no_market`, `settle_market`).

| Instruction | Signer | Purpose | Guards |
| --- | --- | --- | --- |
| `initialize_config` | admin (first caller) | One-time setup: admin authority, tickers, oracle config | None restrict who calls first — see §8 and `docs/risks-and-limitations.md` §5 |
| `update_config` | admin | Change provider, allowlist, thresholds, tickers, pause | Admin-signer check |
| `create_market` | admin | Create one `Market` + two mints + vault + two escrows for one ticker/strike/day | Admin-signer check; fails if the market key is already in use (§3's mint-reuse rule) |
| `add_strike` | admin | Same as `create_market`, usable intraday to add an extra strike | Same as `create_market`; also used by the `extend` automation job (§5) |
| `create_book` | admin | Idempotent, called repeatedly to build the `Book` account within Solana's per-transaction data-growth limit | Re-validates an existing account and no-ops rather than erroring on retry |
| `mint_pair` | user | Deposit $1.00 USDC, receive 1 Yes + 1 No | Blocked while paused |
| `redeem_pair` | user | Burn 1 Yes + 1 No, receive $1.00 USDC | Works in any market state; never blocked by pause |
| `place_order` | user | Post a limit or IOC order on the Yes/USDC book | Blocked while paused; self-match refusal |
| `cancel_order` | owner | Refund a resting order's escrow | Owner-only; never blocked by pause |
| `buy_no_market` | user | Mint, sell Yes IOC, redeem any unfilled pairs — one approval, ends holding only No | Blocked while paused; self-match refusal; capped at 8 fills per transaction |
| `buy_no_limit` | user | Mint, post the Yes as a resting ask | Blocked while paused; never crosses the book (`DECISIONS.md` §18) |
| `sell_no_market` | user | Buy Yes IOC, redeem the resulting pair | Blocked while paused; capped at 8 fills per transaction |
| `settle_market` | anyone (service in practice) | Read the guarded oracle price, write the outcome | Refuses before `close_ts`; idempotent (`AlreadySettled` on a second call); the four oracle guards (§4) |
| `admin_settle_override` | admin | Manual-price settlement, only after an enforced delay | Admin-signer check; market must still be `Open`; `now >= close_ts + override_delay_secs` (minimum 3,600 s) |
| `redeem_winning` | user | After settlement, burn the winning side, receive $1.00 per token | Requires only the winning side's token account, not both (`DECISIONS.md` §11) |
| `pause` / `unpause` | admin | Halt/resume minting and trading; never blocks redemption | Admin-signer check |
| `close_book` / `close_market` | admin | Reclaim rent once settled and empty | Market must be `Settled`; book/escrows (and, for `close_market`, the vault) must be empty |
| `mock_write_price` | allowlisted publisher | Mock-provider only: post a signed price update | Publisher key must be in `Config.publishers`; refused on any cluster but devnet |

**How to refresh:** `grep -n "pub fn" programs/meridian/src/lib.rs` for the function list;
`programs/meridian/src/errors.rs` for the exact guard error names.

### One book, two perspectives

Each strike has **exactly one order book**: Yes tokens traded against USDC. Because Yes + No
always equals $1.00, selling a Yes is economically identical to buying a No — so the "No book" is
just the Yes book read upside down. Four user-facing actions map onto two book operations:

| User clicks | What happens on chain | Book side |
| --- | --- | --- |
| Buy Yes | Buy Yes from the ask side | Buying Yes |
| Sell No | Buy Yes from the ask side (now holding Yes+No = $1.00 redeemable) | Buying Yes |
| Buy No | Mint a pair, sell the Yes on the bid side, keep the No | Selling Yes |
| Sell Yes | Sell Yes on the ask side | Selling Yes |

**Buy No, worked through the actual instruction (`buy_no_market`):** the user deposits $1.00 per
token requested, which mints an equal number of Yes and No tokens inside the same transaction;
the program immediately tries to sell the minted Yes tokens as an immediate-or-cancel order
against the book's resting bids; whatever portion fails to fill is immediately redeemed back
(burn the unsold Yes+No pair, return its $1.00) so the user is never left holding an unwanted Yes
position. All of this happens in one transaction and one wallet approval — Solana's atomicity
guarantee (either every instruction in the transaction succeeds, or none do) is what makes this
safe: there is no intermediate state where the user has paid and not yet resolved into "holding
No only."

`buy_no_limit` is the same mint step followed by posting the Yes as a resting ask instead of an
IOC sell — the user holds both Yes and No until the ask fills, which is the one case where
transient dual-sided holding is expected rather than a bug.

### Invariants and enforcement

| Invariant | Enforced by |
| --- | --- |
| Yes payout + No payout = $1.00, always | `mint_pair`/`redeem_pair` mint and burn equal quantities of both sides in one instruction; settlement writes a single outcome that `redeem_winning` reads |
| A pause can never trap funds already a user's | `redeem_pair`, `redeem_winning`, `cancel_order` never check `Config.paused` |
| No double settlement | `settle_market` and `admin_settle_override` both check market state; a second call returns `AlreadySettled` rather than re-paying |
| No self-trading | Every path that matches orders refuses a self-match (`DECISIONS.md` §10) |
| A market key is never reused once burned | `create_market` fails with "account already in use" on a colliding ticker/day/strike; the morning job skips a colliding strike and continues (`DECISIONS.md` §25) |
| Settlement cannot be rushed by an admin | `admin_settle_override` enforces `override_delay_secs >= 3,600` regardless of config, and flags `settled_by_override = true` in the emitted `Settled` event so human intervention is always visible on chain |

## 4. Oracle guards, settlement window, override

The program never talks to a price vendor directly. It calls one function
(`programs/meridian/src/oracle/mod.rs`):

```rust
fn read_quote(config: &Config, ticker: &TickerInfo, price_account: &AccountInfo, clock: &Clock)
    -> Result<OracleQuote>
```

which dispatches on `Config.oracle_provider` to one of two provider arms, each doing only an
owner check, a parse, and an attestation check, before handing off to one shared guard chain:

| Provider | Owner check | Parse | Attestation |
| --- | --- | --- | --- |
| `MockPyth` | Account owned by this program, at PDA `["mock_price", feed_id]` | `MockPriceUpdate` | Publisher key in `Config.publishers` |
| `PythReceiver` | Account owned by Pyth's devnet receiver program | `PriceUpdateV2` via `pyth-solana-receiver-sdk` | `verification_level == Full` (Wormhole guardian signatures verified by the receiver itself) |

Then **four guards**, applied identically regardless of which provider produced the quote, in
this exact order (`programs/meridian/src/oracle/mod.rs`, confirmed against
`programs/meridian/src/errors.rs`), each failing closed with its own error:

1. **Bad price** (`OracleBadPrice`) — reject a non-positive price or one that overflows on
   normalization.
2. **Staleness** (`OracleStale`) — reject anything older than `max_staleness_secs` (300 s).
3. **Too old relative to the close** (`OracleTooOld`) — reject a price published before
   `close_ts − min_publish_offset_secs` (60 s), so a mid-session read can't be passed off as the
   close.
4. **Confidence** (`OracleLowConfidence`) — reject if the confidence interval exceeds
   `max_conf_bps` (25 bps) of the price.

Only a quote that passes all four reaches the at-or-above comparison. Switching providers is a
`Config.oracle_provider` update, not a program change or a guard rewrite — see
`docs/deployment.md` §3 for the actual command. Full detail:
`specs/001-binary-outcome-markets/contracts/oracle-provider.md`.

**Settlement window.** Pyth's equity feeds stop advancing after the 4:00 PM bell, so with the
5-minute staleness bound above, settlement must land between **16:00 and 16:05 ET**. The
automation service's settle job therefore starts at **16:00:30 ET**, not 16:05, retrying every 30
seconds — nine attempts inside the window. `settle_market` itself refuses to run before
`close_ts` and is idempotent: a second call after settlement returns `AlreadySettled`, which the
service treats as a successful no-op rather than a second payout.

If the retry loop exhausts 15 minutes without a passing quote, the service posts to
`ALERT_WEBHOOK_URL` and logs at error level — no further automatic retries. From there, the only
path forward is `admin_settle_override(price)`: admin-signer only, requires the market still be
`Open`, and enforced to run no earlier than `close_ts + override_delay_secs` (minimum 3,600 s,
i.e. 17:00 ET on a normal day). The resulting settlement is flagged `settled_by_override = true`
and emitted in the `Settled` event, so the fact that a human intervened is always visible in the
on-chain record, not hidden.

In practice, on the two days this has run against the real Pyth path, settlement has completed
without a retry exhausting the window: 2026-10-08 (one attempt, 46 markets, 16:00:40-16:00:52 ET)
and 2026-10-09 (nine attempts, 47 markets, 16:04:49-16:04:54 ET — devnet confirmations exceeded
the worker's 30 s limit on the first eight). See `docs/deployment.md` §2 and §5 for the KEY_METRICS
counterpart.

**Pause semantics.** `pause()`/`unpause()` (admin-only) flip `Config.paused`. A pause blocks
`mint_pair`, `place_order`, `buy_no_market`, `buy_no_limit`, and `sell_no_market` — nothing that
would create a new position or new exposure. It never blocks `redeem_pair`, `redeem_winning`, or
`cancel_order`: a pause can freeze new activity but can never trap funds that are already a
user's.

**Rent lifecycle.** Because every contract is same-day expiry, accounts are closed and their rent
reclaimed rather than accumulating forever (`DECISIONS.md` §6). Two mechanics:

- **`create_book` growth cap.** Solana limits how much any single account's data length may grow
  within one transaction (`MAX_PERMITTED_DATA_INCREASE`, 10,240 bytes) — identical for a CPI
  `system_program::create_account` and a direct `AccountInfo::resize`. A `Book` at the production
  capacity (128 orders/side) needs 16,512 bytes, which exceeds that limit in a single shot, so
  `create_book` is a separate, idempotent instruction: call it repeatedly (each call is its own
  transaction, so each gets a fresh budget) until `Market.book` is set. Calling it again
  afterward re-validates the existing account and returns a no-op rather than erroring, so a
  client retrying a missed confirmation never needs special-case handling.
- **`close_book` / `close_market`.** Admin-only, callable once a market is `Settled` and its book
  and escrows are empty (and, for `close_market`, the vault is empty too). Returns the account's
  rent to the admin. The nightly `reclaim` job (20:00 ET) does this automatically for markets
  settled more than a day earlier.

**What is reclaimed and what is not.** `close_book`/`close_market` return rent for the `Market`
account, its `Book`, its collateral vault, and its two order-escrow accounts. They do **not**
close the market's two SPL token mints (the Yes mint and the No mint, created by `create_market`)
— classic SPL mints have no close instruction in the token program the way a token *account*
does, so every market this system ever creates permanently retains two 82-byte mint accounts and
their rent (approximately 0.0014616 SOL each, approximately 0.0029 SOL per market at today's rent
rate). This is a small, indefinitely accumulating cost with no reclaim path today: roughly 45
markets/day (the default 7-ticker ladder) adds on the order of 0.13 SOL/day in permanently locked
rent, scaling linearly with however many days the deployment runs. Nothing in this system
reclaims it.

## 5. Automation

One Node process (`services/automation`), scheduled with `node-cron` in `America/New_York`:

| Job | Schedule | What it does |
| --- | --- | --- |
| `morning` | `0 8 * * 1-5` (08:00 ET, weekdays) | Per enabled ticker: read the previous close, compute the strike ladder, `create_market` per strike |
| `publisher` (mock provider only) | `* * * * *`, gated 09:25-16:10 ET | `mock_write_price` from Finnhub + Nasdaq disagreement as confidence |
| `extend` | `*/5 * * * 1-5`, gated 09:35-15:45 ET | For each ticker with markets already created today, adds one strike $10 above/below the ladder's edge after two consecutive ticks within $5 of that edge; capped at 2 added strikes per ticker per day; never removes a strike (`DECISIONS.md` §27) |
| `settle` | `30 0 16 * * 1-5` (16:00:30 ET) | `provider.publish` then `settle_market` per open market, retrying every 30 seconds for 15 minutes, then alerting |
| `reclaim` | `0 20 * * 1-5` (20:00 ET) | `close_book`/`close_market` for markets settled over a day ago with empty books/vaults |

The same job code is exposed as CLI entry points
(`pnpm --filter automation run job <morning|settle|publisher|extend|reclaim>`), used by both the
devnet deployment scripts and the demo script (`docs/demo-script.md`), with a
`--day`/`--close-in` escape hatch for driving a synthetic trading day without waiting for the
real market hours.

**Retry and alert.** `settle` retries every 30 s for 15 minutes before giving up and posting to
`ALERT_WEBHOOK_URL` (Slack). `extend`'s per-ticker cap, its two-consecutive-tick streak (keyed by
trading day; reset by a gap wider than 1.5x the 5-minute interval, a day change, or a failed
observation), and a pending-book retry set are all persisted to `EXTEND_STATE_PATH` (default
`./data/extend-state.json`) so a worker restart does not silently re-open the cap or forget an
in-progress streak.

**Event index.** The worker builds and continuously maintains a decoded event stream in memory
(`services/automation/src/events-index.ts`), persists a JSON snapshot so a restart resumes rather
than re-paying for the whole history, and serves it over the status server as `GET /events`
(optionally `?after=<signature>`). This replaced a per-browser chain replay that took about three
minutes to catch up on an empty cache against roughly 600 transactions; the worker's own cold
build measured 612 transactions in about three minutes, once, on the worker instead of in every
browser (`AI_USAGE.md`, 2026-10-08 entry; `DECISIONS.md` §23). The browser's `events-cache.ts`
fetches the worker's index first when `NEXT_PUBLIC_EVENTS_INDEX_URL` is set, validates
`programId`/genesis hash before trusting it, and merges in; chain-based forward sync still runs
afterward as the fallback.

**Extension job.** Covered above and in `DECISIONS.md` §27: `runExtendTick` in
`services/automation/src/jobs/extend.ts` is the newest job (added 2026-10-09), added so an
intraday price move through the ladder's edge no longer needs a manual "Add strike" click from
the admin page.

## 6. Frontend data flow

There is no backend database and no indexer. Data sources, all read directly or through thin
server proxies:

- **One poller per data type** (`web/src/hooks/AppDataProvider.tsx`): config every 15 s, prices
  every 15 s, books every 15 s, positions every 30 s, markets every 30 s, automation status every
  10 s. Account reads are batched through `getMultipleAccountsInfo` (100 accounts per call).
- **Book subscriptions.** The web app subscribes to each visible `Book` account over the RPC
  websocket (`onAccountChange`) and decodes it client-side. Account-change notifications arrive
  within a slot (roughly 400 ms), which is what keeps the order book "real time" in the UI.
- **Events → positions and P&L.** The program emits `Minted`, `Fill`, `PairRedeemed`,
  `WinningRedeemed`, `Settled`, and related events. The web app reconstructs a connected wallet's
  positions and realized P&L entirely from that event stream, seeded from the worker's `/events`
  (`web/src/lib/events-cache.ts`, localStorage-cached) with chain replay as fallback. The History
  page is the same event stream, rendered as a list grouped by day.
- **Server routes.** `/api/prices` (Hermes latest, 5 s cache) and `/api/price-history` (Pyth Pro
  History API, 60 s cache) keep the Pyth API key server-side; the Trade page chart renders the
  seeded history plus live appended samples with `lightweight-charts` 5.2.1 (area series, strike
  line, crosshair) — the hand-written sparkline it replaced is gone (`DECISIONS.md` §26).
- **Confirmation toasts.** `web/src/components/ui/Toast.tsx` reads the confirmed transaction's own
  events (`web/src/lib/trade-result.ts`) to show order/quote/cancel/redemption confirmations,
  rather than re-deriving them from a separate poll.

This keeps the frontend non-custodial in the same sense the program is: there is nothing it knows
that a wallet owner couldn't reconstruct themselves from public on-chain data.

## 7. Deployment topology

Project `meridian-binary-markets` on Railway, one environment (`production`), two services built
from this repo:

| Service | Image | Start | Public |
| --- | --- | --- | --- |
| `web` | `deploy/web.Dockerfile` | `next start` on `$PORT` | `https://web-production-385a5.up.railway.app` |
| `automation` | `deploy/automation.Dockerfile` | `automation start` (cron: morning 08:00, settle 16:00:30, publisher, extend every 5 min 09:35-15:45, reclaim 20:00 ET) | status endpoint at `https://automation-production-c478.up.railway.app/status` |

Devnet program ID `3XQgqYNXPeZr5o2NUmnuPm9hk5mPrZpiEsFE62pjVkBn`; the full recorded-address table
(Config PDA, publisher key, USDC mint, deploy slot, settlement history) is `docs/deployment.md`
§2 — that table, not `declare_id!` in source, is the source of truth for what is actually live,
because the program keypair that produces `declare_id!`'s address is generated locally and
gitignored.

Locally, `compose.yml`'s `dev` service is the only supported path; Docker is the only toolchain
(`DECISIONS.md` §7) — nothing needs installing on the host except Docker, Compose, Make, and
Bash.

**Mint-rent arithmetic, worked through an example.** Each market permanently retains two SPL
mints (Yes, No) at 82 bytes each, about 0.0014616 SOL rent per mint at today's rent rate, so about
0.0029 SOL per market that can never be reclaimed. At the default 7-ticker, ~45-market-per-day
ladder, that is on the order of 0.13 SOL/day, growing linearly with the number of days the
deployment runs, since nothing in the system closes a mint. This is the one rent cost that is not
recycled by the nightly `reclaim` job — see §4 above and `KEY_METRICS.md` §F.

## 8. Security and trust assumptions

- **Admin key.** Controls `initialize_config`, `update_config`, `create_market`/`add_strike`,
  `pause`/`unpause`, `admin_settle_override`, and `close_book`/`close_market`. Held as a Railway
  environment variable (`ADMIN_KEYPAIR_JSON`) today — acceptable for a devnet demo with no real
  funds, not for a deployment holding real value (`docs/deployment.md` §6).
- **Publisher key.** The one key allowed to call `mock_write_price` (mock provider only); its
  on-chain allowlist membership is the entire trust anchor for the mock price. Also a Railway
  environment variable.
- **Upgrade authority.** Equal to the admin key on this deployment (`docs/deployment.md` §2); a
  compromise of that one key can redeploy the program entirely, which is a materially larger
  blast radius than any single instruction.
- **First-caller-becomes-admin.** `initialize_config` has no check restricting who calls it first;
  the only mitigation is operational — running `make init-config` immediately after `make deploy`
  — not a same-transaction guarantee (`docs/risks-and-limitations.md` §5).
- **Custody.** Only two things ever sit in program-owned accounts: a market's collateral vault
  (USDC backing minted pairs) and a resting order's escrow (the Yes tokens or USDC behind a limit
  order). The program never custodies anything beyond what a specific mint or a specific resting
  order requires, and `redeem_pair`/`redeem_winning`/`cancel_order` are never blocked by pause, so
  a user's own funds are never strandable by an admin action short of a program upgrade.
- **Oracle trust.** Until 2026-10-08, settlement acted on a price chosen and signed by our own
  service (the mock provider) — see §2 above and `docs/risks-and-limitations.md` §1. Since then,
  the live provider is `pythReceiver`, an independent network, though the API key granting equity
  access is a free grant whose scope has changed more than once.

## 9. Known limitations

Full detail lives in `docs/risks-and-limitations.md` (oracle trust history, no free source
carrying the official closing-auction print, narrow settlement window, first-caller-admin risk,
devnet faucet/RPC limits, bounded book capacity and per-transaction fill cap, partial browser
P&L history, the `--arch v1` build pin, and the market-key-reuse rule) and `SCALING.md` (what
breaks first at 10/100/1,000/10,000/100,000 users, and the smallest fix at each size — the single
hot `Book` account per strike, the single automation worker, hosted-not-KMS keys, and the
permanently-retained SPL mints are the recurring themes). Neither document makes any regulatory
or compliance claim; both are purely technical accounts of what this devnet build does and does
not guarantee.
