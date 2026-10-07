# Architecture

> **Draft status.** This is a Wave 6 draft, to be finalized in Wave 8. Technical detail here is
> accurate against the design in `specs/001-binary-outcome-markets/` as of this wave; anything
> specific to the Wave 7 devnet run (addresses, transaction signatures) is covered in
> `docs/deployment.md`, not here.

This document explains how Meridian is built: the on-chain accounts and instructions, the
one-book order-book mechanic, the oracle provider interface and its guards, the settlement
window, rent lifecycle, the automation schedule, and how the frontend turns on-chain events into
what a trader sees. For the *why* behind each major choice, see `DECISIONS.md`. For a from-scratch
explanation of the domain, see `docs/ONBOARDING.md`.

## 1. System overview

```
  ┌─────────────────┐     reads/writes      ┌──────────────────────┐
  │  web/           │  ──────────────────▶  │  programs/meridian  │
  │  Next.js + TS   │   user-signed txns    │  Rust + Anchor       │
  │                 │                       │                      │
  │  wallet connect │                       │  Config / Market     │
  │  order book UI  │                       │  mint / redeem       │
  │  4 trade paths  │                       │  Book (order book)   │
  │  portfolio/P&L  │                       │  settlement          │
  └────────┬────────┘                       └──────────────────────┘
           │ subscribes (websocket)                ▲          ▲
           │ account changes + events              │          │ guarded
           ▼                                        │          │ read
  ┌─────────────────┐   create / settle            │          │
  │  services/      │  ────────────────────────────┘          │
  │  automation     │                                  ┌────────────────┐
  │  (Node cron)    │   posts signed price             │  price account │
  │  oracle adapter │  ──────────────────────────────▶ │  (on chain)    │
  └────────┬────────┘                                  └────────────────┘
           │ reads the closing price
           ▼
   price source (Pyth Hermes, or Finnhub + Nasdaq for the mock)
```

Three pieces, one program:

- **`programs/meridian`** (Rust/Anchor, on chain) — owns every rule that must not be broken:
  contract state, the collateral vault, minting, redemption, the order book and matching engine,
  and settlement. Enforced here because this is the only layer a malicious client cannot bypass.
- **`web/`** (Next.js/TypeScript) — wallet connection, order book display from both perspectives,
  the four trade buttons, portfolio and P&L, admin page. Translates user intent into transactions
  and derives state from events; holds nothing authoritative.
- **`services/automation`** (Node.js) — the scheduler: creates markets each morning, publishes a
  signed closing price, triggers settlement each afternoon, reclaims rent at night. Cannot move
  user funds; the one real power it holds is that its publisher key is on the on-chain allowlist,
  so it is the thing that tells the system what the closing price was.

## 2. Accounts and instructions

Full field-level detail: `specs/001-binary-outcome-markets/data-model.md`. Full instruction
account lists: `specs/001-binary-outcome-markets/contracts/program-instructions.md`.

**Accounts:** `Config` (singleton: admin, pause flag, oracle provider/program, publisher
allowlist, guard thresholds, the seven tickers, default book capacity), `Market` (one per
ticker/strike/trading-day: state, outcome, settlement price, the two SPL mints, the vault, a
pointer to its `Book`), `Book` (one per market: a fixed header plus variable-capacity bid/ask
arrays of price-time-ordered orders), and `MockPriceUpdate` (one per feed ID, mock-provider only —
mirrors the fields a real Pyth `PriceUpdateV2` would carry).

**The 20 instructions**, grouped by the PRD §5.1 function they implement:

| Instruction | Signer | Purpose |
| --- | --- | --- |
| `initialize_config` | admin | one-time setup: admin authority, tickers, oracle config |
| `update_config` | admin | change provider, allowlist, thresholds, tickers, pause |
| `create_market` | admin | create one Market + two mints + vault + two escrows for one ticker/strike/day |
| `add_strike` | admin | same as `create_market`, usable intraday to add an extra strike |
| `create_book` | admin | idempotent, called repeatedly to build the `Book` account within Solana's per-transaction data-growth limit (see §5) |
| `mint_pair` | user | deposit $1.00 USDC, receive 1 Yes + 1 No |
| `redeem_pair` | user | burn 1 Yes + 1 No, receive $1.00 USDC — works in any market state |
| `place_order` | user | post a limit or IOC order on the Yes/USDC book |
| `cancel_order` | owner | refund a resting order's escrow |
| `buy_no_market` | user | mint, sell Yes IOC, redeem any unfilled pairs — one approval, ends holding only No |
| `buy_no_limit` | user | mint, post the Yes as a resting ask |
| `sell_no_market` | user | buy Yes IOC, redeem the resulting pair |
| `settle_market` | anyone (service in practice) | read the guarded oracle price, write the outcome |
| `admin_settle_override` | admin | manual-price settlement, only after an enforced delay |
| `redeem_winning` | user | after settlement, burn the winning side, receive $1.00 per token |
| `pause` / `unpause` | admin | halt/resume minting and trading; never blocks redemption |
| `close_book` / `close_market` | admin | reclaim rent once settled and empty |
| `mock_write_price` | allowlisted publisher | mock-provider only: post a signed price update |

(Every row above is one `pub fn` inside `#[program] mod meridian` in `programs/meridian/src/lib.rs`
— `pause`/`unpause` and `close_book`/`close_market` are each two separate instructions sharing one
table row for brevity, which is why the row count above is smaller than 20. Count them yourself
with `grep -c "pub fn" programs/meridian/src/lib.rs` inside the `#[program]` module.)

## 3. One book, two perspectives

Each strike has **exactly one order book**: Yes tokens traded against USDC. Because Yes + No
always equals $1.00, selling a Yes is economically identical to buying a No — so the "No book" is
just the Yes book read upside down. Four user-facing actions map onto two book operations:

| User clicks | What happens on chain | Book side |
| --- | --- | --- |
| Buy Yes | buy Yes from the ask side | buying Yes |
| Sell No | buy Yes from the ask side (now holding Yes+No = $1.00 redeemable) | buying Yes |
| Buy No | mint a pair, sell the Yes on the bid side, keep the No | selling Yes |
| Sell Yes | sell Yes on the ask side | selling Yes |

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
transient dual-sided holding is expected rather than a bug (constitution Principle III).

## 4. The oracle provider interface and its guards

The program never talks to a price vendor directly. It calls one function:

```rust
fn read_quote(config: &Config, ticker: &TickerInfo, price_account: &AccountInfo, clock: &Clock)
    -> Result<OracleQuote>
```

which dispatches on `Config.oracle_provider` to one of two provider arms, each doing only an
owner check, a parse, and an attestation check, before handing off to one shared guard chain:

| Provider | Owner check | Parse | Attestation |
| --- | --- | --- | --- |
| `MockPyth` | account owned by this program, at PDA `["mock_price", feed_id]` | `MockPriceUpdate` | publisher key in `Config.publishers` |
| `PythReceiver` | account owned by Pyth's devnet receiver program | `PriceUpdateV2` via `pyth-solana-receiver-sdk` | `verification_level == Full` (Wormhole guardian signatures verified by the receiver itself) |

Then **four guards**, applied identically regardless of which provider produced the quote, each
failing closed with its own error:

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

## 5. Settlement window and override

Pyth's equity feeds stop advancing after the 4:00 PM bell, so with the 5-minute staleness bound
above, settlement must land between **16:00 and 16:05 ET**. The automation service's settle job
therefore starts at **16:00:30 ET**, not 16:05, retrying every 30 seconds — nine attempts inside
the window. `settle_market` itself refuses to run before `close_ts` and is idempotent: a second
call after settlement returns `AlreadySettled`, which the service treats as a successful no-op
rather than a second payout.

If the retry loop exhausts 15 minutes without a passing quote, the service posts to
`ALERT_WEBHOOK_URL` and logs at error level — no further automatic retries. From there, the only
path forward is `admin_settle_override(price)`: admin-signer only, requires the market still be
`Open`, and enforced to run no earlier than `close_ts + override_delay_secs` (minimum 3600 s,
i.e. 17:00 ET on a normal day). The resulting settlement is flagged `settled_by_override = true`
and emitted in the `Settled` event, so the fact that a human intervened is always visible in the
on-chain record, not hidden.

## 6. Pause semantics

`pause()`/`unpause()` (admin-only) flip `Config.paused`. A pause blocks `mint_pair`,
`place_order`, `buy_no_market`, `buy_no_limit`, and `sell_no_market` — nothing that would create a
new position or new exposure. It never blocks `redeem_pair`, `redeem_winning`, or `cancel_order`:
a pause can freeze new activity but can never trap funds that are already a user's.

## 7. Rent lifecycle

Because every contract is same-day expiry, accounts are closed and their rent reclaimed rather
than accumulating forever (DECISIONS.md §6). Two mechanics:

- **`create_book` growth cap.** Solana limits how much any single account's data length may grow
  within one transaction (`MAX_PERMITTED_DATA_INCREASE`, 10,240 bytes) — identical for a CPI
  `system_program::create_account` and a direct `AccountInfo::resize`. A `Book` at the production
  capacity (128 orders/side) needs 16,512 bytes, which exceeds that limit in a single shot, so
  `create_book` is a separate, idempotent instruction: call it repeatedly (each call is its own
  transaction, so each gets a fresh budget) until `Market.book` is set. Calling it again afterward
  re-validates the existing account and returns a no-op rather than erroring, so a client retrying
  a missed confirmation never needs special-case handling.
- **`close_book` / `close_market`.** Admin-only, callable once a market is `Settled` and its book
  and escrows are empty (and, for `close_market`, the vault is empty too). Returns the account's
  rent to the admin. The nightly `reclaim` job (20:00 ET) does this automatically for markets
  settled more than a day earlier.

**What is reclaimed and what is not.** `close_book`/`close_market` return rent for the `Market`
account, its `Book`, its collateral vault, and its two order-escrow accounts. They do **not**
close the market's two SPL token mints (the Yes mint and the No mint, created by `create_market`)
— classic SPL mints have no close instruction in the token program the way a token *account*
does, so every market this system ever creates permanently retains two 82-byte mint accounts and
their rent (≈0.0014616 SOL each, ≈0.0029 SOL per market at today's rent rate). This is a small,
indefinitely accumulating cost with no reclaim path today: roughly 45 markets/day (the default
7-ticker ladder) adds on the order of 0.13 SOL/day in permanently locked rent, scaling linearly
with however many days the deployment runs. Nothing in this system reclaims it; it is disclosed
here rather than implied away by "accounts are closed and their rent reclaimed" above, which is
true for every *other* account type but not for mints.

## 8. Automation schedule

One Node process (`services/automation`), scheduled with `node-cron` in `America/New_York`:

| Job | Schedule | What it does |
| --- | --- | --- |
| `morning` | 08:00 ET | per enabled ticker: read the previous close, compute the strike ladder, `create_market` per strike |
| `publisher` (mock only) | every 60 s, gated 09:25–16:10 ET | `mock_write_price` from Finnhub + Nasdaq disagreement as confidence |
| `settle` | 16:00:30 ET | `provider.publish` then `settle_market` per open market, retrying every 30 s for 15 minutes, then alerting |
| `reclaim` | 20:00 ET | `close_book`/`close_market` for markets settled over a day ago with empty books/vaults |

The same job code is exposed as CLI entry points (`pnpm --filter automation run job <morning|
settle|publisher|reclaim>`) used by both the devnet deployment scripts and the demo script
(`docs/demo-script.md`), with a `--day`/`--close-in` escape hatch for driving a synthetic trading
day without waiting for the real market hours.

## 9. Frontend data flow

There is no backend database and no indexer. Two data sources, both read directly from the chain:

- **Book subscriptions.** The web app subscribes to each visible `Book` account over the RPC
  websocket (`onAccountChange`) and decodes it client-side. Account-change notifications arrive
  within a slot (roughly 400 ms), which is what keeps the order book "real time" in the UI.
- **Events → positions and P&L.** The program emits `Minted`, `Fill`, `PairRedeemed`,
  `WinningRedeemed`, `Settled`, and related events. The web app reconstructs a connected wallet's
  positions and realized P&L entirely from that event stream (via `getSignaturesForAddress` plus
  log parsing), with no server-side state. The History page is this same event stream, rendered
  as a list.

This keeps the frontend non-custodial in the same sense the program is: there is nothing it knows
that a wallet owner couldn't reconstruct themselves from public on-chain data.
