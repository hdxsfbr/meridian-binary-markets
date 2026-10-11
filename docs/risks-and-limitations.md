# Risks and limitations

> This note states the honest limitations of the system as built and deployed on devnet, so a
> reviewer does not have to discover them.

**This note makes no regulatory or compliance claims of any kind.** It is a technical account of
what this devnet build does and does not guarantee. It is not a legal opinion, not a statement of
regulatory status, and not advice about what would be required to operate anything like this with
real funds or real users. Nothing in this document should be read as asserting that Meridian is,
or could become, compliant with any securities, derivatives, commodities, or money-transmission
law in any jurisdiction.

## 1. The oracle's trust model today is one publisher we control

The system's price source sits behind a provider interface (`docs/architecture.md` §4), and the
production target is **Pyth**. Today, the active default is a Pyth-shaped **mock provider**: the
automation service reads a price from two free sources (Finnhub and Nasdaq), treats their
disagreement as the confidence measure, signs the result with a publisher key the service itself
holds, and posts it through the same account layout and the same four guards a real Pyth update
would go through. The guards are real and tested — staleness, confidence, publisher attestation,
and fail-closed behavior all work exactly the same whether the quote came from the mock or from
Pyth. What is not real yet is independence: until the equity entitlement lands (see §2), the
number settlement acts on was chosen and signed by our own service, not by an independent network.
That is a materially weaker trust model than Pyth, and it is disclosed here rather than left for a
reviewer to discover, per the project's own engineering principles.

## 2. Pyth: resolved 2026-10-08 (entitlement granted, first real on-chain settlement done)

**Update 2026-10-08:** the project's Pyth key is now entitled to all seven PRD equity feeds. The
on-chain `Config` provider is `pythReceiver`, and at the 4:00 PM ET close the settle job fetched
each ticker's Hermes closing update, posted it to the devnet receiver, and settled every listed
market against it with no override (see `deployment.md` §2). The remaining limitation is that the
key is a free grant whose scope has changed twice this week; `probe pyth` verifies entitlement in
seconds if settlement ever fails with `Not entitled`. The section below is kept as history.

### History: Pyth equity entitlement was pending; no update had been posted on devnet

The Pyth API key in use is active, but a request against an `Equity.US.*` feed returns `403 Not
entitled` — Pyth gates US equity feeds behind a separate grant that has been requested but has not
yet landed. Rather than wait on that grant to prove anything, this wave exercised the **Hermes
fetch** against the real **BTC/USD crypto feed** (no equity entitlement needed) and confirmed the
auth shape, feed shape, and staleness math against a genuine, live Pyth observation.

What this wave does **not** have is a posted, on-chain receiver update: the one attempt to post
the BTC/USD update to the devnet receiver program failed because the publisher key had 0 SOL and
the devnet faucet returned `HTTP 429` on the single airdrop attempt the probe makes (no retry
loop, by design). Per the fallback this task specified, the probe instead built a
`PriceUpdateV2` **fixture directly from the real Hermes-observed BTC price**, using the receiver
SDK's own Anchor/Borsh account coder to produce the same bytes a real post would have — marked
`synthetic: true` in its JSON sidecar — and wrote it to
`programs/meridian/tests/fixtures/pyth_price_update_btc.bin`. A LiteSVM test
(`programs/meridian/tests/oracle_pyth_real.rs`) loads that fixture under the real receiver
program's ID as owner and exercises the program's own `PriceUpdateV2::try_deserialize` +
`normalize_price` + guard chain against it, proving the **account layout, parsing, and guard
logic** handle a `VerificationLevel::Full` update correctly. It does **not** prove that a
transaction was ever broadcast to devnet, confirmed, or that the Wormhole guardian signatures
inside a live update were actually verified on chain — that remains to be done once the faucet
or a manually funded publisher allows the post, tracked for Wave 7. Switching the live config
from mock to Pyth is `init-config -- --update --provider pyth` once equities are entitled — a
config change, not a program change (`docs/deployment.md` §3).

**2026-10-07 note:** this section's findings — active Pyth key, equities still `403 Not entitled`,
the pull-oracle path proven only on the BTC/USD crypto feed via a synthetic fixture, nothing posted
to devnet — were also recorded as `DECISIONS.md` §15. That section mirrored a probe finding rather
than an architectural decision, so it has been removed from `DECISIONS.md`; this document (§1–2) is
now the single, authoritative place that statement lives.

## 3. No free source carries the official closing-auction print

The number this system settles on — from either the mock or Pyth — is a consolidated/aggregated
price, not the exchange's official closing-auction print. That specific print is a licensed data
product that free and low-cost sources do not carry. In the spike behind this decision, the
consolidated price agreed with the official close to within a few hundredths of a percent on the
days checked. That is acceptable for a devnet build with no real funds at stake; it is not
something this document — or any product-facing text — should overstate as "the official close."

## 4. The settlement window is narrow, and missing it has a defined fallback

Pyth's equity feeds stop advancing shortly after the 4:00 PM bell. Combined with the 5-minute
staleness guard, settlement has to land between **16:00 and 16:05 ET**. The automation service
starts retrying at 16:00:30 ET every 30 seconds. If nothing passes the guards inside a 15-minute
retry window, the service stops retrying automatically, posts an alert, and the market sits
"awaiting settlement." The only way forward from there is the admin override, which is
intentionally slow: it cannot be called until at least one hour past the close (17:00 ET on a
normal day), and every override is recorded on chain as an override rather than a normal
settlement. This is a deliberate trade-off: a late settlement is an inconvenience that is visible
and recoverable; a wrong settlement pays the wrong side and cannot be undone. The system is built
to prefer being late over being wrong.

## 5. Whoever calls `initialize_config` first becomes admin — deployment-risk, mitigated by sequencing

The `initialize_config` instruction has no check restricting who is allowed to call it first:
Solana programs are public, so in principle anyone watching for a fresh deploy could race to call
it and become the admin authority before the intended operator does. This is accepted as a
documented risk rather than fixed in code this wave. `make deploy` and `make init-config` are two
separate commands, run back to back (`docs/deployment.md` §1.2 and §1.3) — the deploy script only
deploys and verifies the program binary, it does not call `initialize_config`. The window where
anyone could race to become admin is the time between the deploy transaction landing and the
operator running `make init-config` immediately afterward; the mitigation is purely operational
(running that second command without delay), not a same-transaction guarantee. A stronger check
(e.g. requiring the caller to match the program's upgrade authority) is deferred.

## 6. Devnet faucet and RPC limits bound what a reviewer can reproduce in one sitting

The devnet SOL faucet rate-limits and caps individual requests at roughly 2 SOL, while deploying
the program needs on the order of 7–9 SOL for the deployer (the program-data account's rent plus
a temporary buffer account of similar size — see `docs/deployment.md` §1.1 for the exact figures
and why it's several airdrops, not one or two). Running the full daily lifecycle at the production
book capacity (128 orders/side, ~5.8 SOL/day) is not expected to fit a reviewer's faucet allowance; the demo
configuration (16 orders/side, ~1.25 SOL/day) is the one actually meant to be reproduced. The
public devnet RPC endpoint also rate-limits websocket subscriptions, which the order-book UI
depends on for real-time updates; `.env.example`'s `SOLANA_WS_URL` is a variable specifically so a
higher-limit provider (e.g. Helius or Triton devnet endpoints) can be substituted if the public
endpoint throttles during a demo.

## 7. The order book has a bounded capacity and a bounded per-transaction fill cap

Each `Book` account is created with a fixed per-side capacity (16 at demo scale, 128 at
production scale). A full side rejects a new resting order (`BookFull`) rather than evicting an
existing one or corrupting state — so under heavy simulated load on a single strike, new limit
orders can be refused even though the underlying question is far from resolved. Separately,
matching a single transaction against the book is capped at 8 fills; a taker order that would
need more fills than that takes 8 and either rests the remainder (if it was a limit order) or has
the remainder returned unfilled (if it was immediate-or-cancel). This bound exists to keep every
transaction comfortably under Solana's default compute budget, not because larger fills are
unsafe — a large market order simply needs to be split across more than one transaction.

## 8. Portfolio P&L is reconstructed from events in the browser, and may be partial

There is no backend database or indexer. The web app derives a connected wallet's positions and
realized P&L entirely from on-chain events (`Minted`, `Fill`, `PairRedeemed`, `WinningRedeemed`,
`Settled`) fetched via `getSignaturesForAddress` and log parsing. Devnet's retained transaction
history is bounded (on the order of days, not months), so a wallet with activity older than that
window will see a P&L and position view built from only the history still available on chain —
the Portfolio and History pages label this as a partial history rather than presenting it as
complete.

## 9. Build note: `--arch v1`

The program is built with `anchor build --arch v1` rather than Anchor's newer default (`--arch
v3`). This is a build-toolchain compatibility fact, not a functional limitation: the `litesvm`
0.12.0 crate the Rust program tests run against rejects a `v3`-compiled `.so` outright
(`InvalidAccountData`), so the pin is required for the test suite to run at all, and the same
build output is what gets deployed. See `DECISIONS.md` §7 for the history of why this changed
across waves.

## 10. No regulatory or compliance claims

To restate plainly, because this is the one sentence a reviewer should not have to go looking
for: nothing in this document, or anywhere else in this repository, asserts or implies that
Meridian satisfies any securities, derivatives, commodities, gaming, or money-transmission
regulation in any jurisdiction, or that it has been reviewed for such compliance. It is a devnet
engineering submission with no real funds and no real users.

## 11. A market key cannot be reused after reclaim

Reclaiming a settled market frees its Market, Book and vault accounts but not its two SPL mints,
which cannot be closed. Because the mint addresses derive from the market key, `create_market`
for the same ticker, trading day and strike will fail forever after with "account already in use".
In normal operation this never happens: each trading day has one set of keys. It bit the first
unattended morning run (2026-10-09) because a test run two days earlier had used that real date as
its synthetic day. Rule: synthetic test days must be dates that can never be real trading days for
the deployment. The morning job now skips a colliding strike and continues (`DECISIONS.md` §25).

## 12. Observability

Operational visibility is deliberately scoped to what this devnet build needs, not a general
monitoring stack: structured JSON logs to stdout/stderr (`services/automation/src/log.ts`), the
`/status` and `/events` read-only endpoints the admin page polls, Slack alerts for settlement,
morning-ladder, and `reconcile` failures (`services/automation/src/alert.ts`), and whatever
Railway's own service metrics expose.

The `reconcile` job (`services/automation/src/jobs/reconcile.ts`, every 30 minutes) is the newest
piece of this. It is read-only -- it never sends a transaction -- and audits five things: that an
`Open` market's vault covers `pairs_outstanding * 1_000_000` with both token supplies exactly equal
to it; that a `Settled` market's vault still covers the winning side's remaining supply (with
`pairs_outstanding` frozen at settlement, so a partly redeemed market is healthy with a much
smaller vault, and a surplus is only flagged when neither side's unredeemed supply explains it);
that no `Open` market is more than 15 minutes past its `close_ts`; that on a trading day from 08:30
ET every enabled ticker has a market for that trading day, open or settled; and that each
cron-scheduled job completed its most recent due run within a 10-minute grace period. Every failure
in a pass is folded into one alert rather than paging per check.

Two limits are inherent to how those last checks work. Each market is read as a single
`getMultipleAccountsInfo` snapshot and any failing check is re-evaluated against a second snapshot
before it is recorded, so the job tolerates reads that straddle a transaction -- but it is still a
sampling audit at 30-minute resolution, not a continuous invariant monitor, and a breach that
appears and is corrected between passes is never seen. And the job heartbeat is in-memory and
scoped to the lifetime of the `start` worker process (`services/automation/src/job-registry.ts`): a
restart resets it, and a manual `job <name>` CLI run happens in its own separate process, so it
neither records a heartbeat for the running worker nor (when `job reconcile` is the command) has
any heartbeat history of its own to judge.

Known limits beyond that, by choice at this scale: no frontend error reporting (a browser-side
exception is invisible to the operator unless the user reports it), no external uptime monitor
(nothing pages if the whole worker process dies or Railway itself is down), and no distributed
tracing (a slow or failing RPC call is diagnosed from the structured logs, not a trace span). None
of this is a regulatory or compliance claim (§10); it is a statement of what a reviewer can and
cannot observe about this build today.

## 13. Demo liquidity

The quotes visible on devnet each morning come from a test wallet driven by a cron on the project
machine (`DECISIONS.md` §33), not from the deployed system and not from users. A real deployment
would have no such wallet; liquidity there depends on market makers choosing to quote.

