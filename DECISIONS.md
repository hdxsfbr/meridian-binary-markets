# Key Decisions

A running log of the decisions made on this project, kept as they happen (not reconstructed
afterward). Feeds directly into the "clear rationale for all architecture and chain decisions;
trade-offs explained" deliverable the partner grades.

---

## 1. Adopt spec-kit for spec-driven development

**Date:** 2026-10-05
**Context:** Same approach as the sibling Cerbo partner project. Meridian is graded on documented
rationale and reproducibility, and spec-kit's artifacts (constitution, spec, plan, tasks) double as
that documentation. The project is also large enough — on-chain program, automation service and
frontend — that an explicit dependency-ordered task breakdown is worth the ceremony.
**Decision:** Initialized spec-kit 1.1.1.dev0 with the Claude Code integration (`specify init
--here --integration claude --script sh`). Workflow: /speckit-constitution → /speckit-specify (fed
from `docs/PRD.md`) → /speckit-plan → /speckit-tasks → /speckit-implement. Generated artifacts are
pruned by hand, not accepted verbatim.
**Trade-off:** Process overhead, and the generated spec overlaps the hand-written PRD — resolved by
having the spec reference PRD requirement IDs rather than duplicate the content. In exchange we get
traceability from partner requirement → spec requirement → task → commit.

## 2. Write a PRD first, from the brief plus the attached PDF

**Date:** 2026-10-05
**Context:** The portal brief and the attached `Gauntlet Project - Meridian.pdf` differ
substantially in depth. The PDF carries the material the portal summary omits: the at-or-above tie
rule, the one-book/four-trade-path model, the strike deduplication behaviour, the 0DTE framing, the
8:00/8:30/9:00 lifecycle breakdown, and the devnet requirement.
**Decision:** Merge both into `docs/PRD.md` with numbered requirements FR-1…FR-10, and treat the
PDF as authoritative wherever it is more specific. The PDF itself is committed at
`docs/Gauntlet-Project-Meridian.pdf`.
**Trade-off:** A hand-written PRD is work the spec-kit flow does not require, but it gives a single
traceable requirement set that both the spec and commit messages can reference. Nothing in the two
sources actually conflicts, so no reconciliation judgment was needed.

## 3. Solana + Anchor, not an EVM L2

**Date:** 2026-10-05
**Context:** The brief allows Solana, an EVM L2 (Arbitrum, Base), or HyperLiquid. Solana is named
as recommended; Rust is a listed required language; and the brief states that if Solana is chosen,
**devnet deployment is required to pass**. The brief also warns that EVM chains "may introduce
latency challenges for on-chain order book performance", and that HyperLiquid may not natively
support this instrument.
**Decision:** Solana with Rust and the Anchor framework. TypeScript/React/Next.js frontend,
TypeScript/Node.js automation service.
**Trade-off:** Anchor and the Solana account model carry a steeper ramp than Solidity, and
devnet-only means no mainnet-grade liquidity to demo against. Against that: sub-second finality
comes free, the chain is what the partner asked for, and PEAK6 Labs builds in this space — work on
their recommended chain is directly legible to the reviewer. Choosing an L2 would have meant
spending part of the submission justifying a choice the brief already discouraged.

## 4. Pyth as primary price oracle, with a documented fallback

**Date:** 2026-10-05
**Status:** **SUPERSEDED by §7 on 2026-10-05.** Kept in full rather than edited away, because the
reasoning below is still correct about *what the oracle must provide* — it was wrong only about
whether Pyth can provide it on devnet. See §7 for what replaced it and why.
**Context:** The brief requires an oracle that supplies the previous day's close (for the morning
strike ladder) and the current day's close at 4:00 PM ET (for settlement), is readable on-chain
during the settlement transaction, and supports both a **staleness check** and a
**confidence/quality check**. The choice must be justified.
**Decision:** Pyth as the primary source — it carries first-party equity feeds including the MAG7,
is native to Solana, and its feed structure exposes a publish timestamp and a confidence interval,
which map directly onto the two guards the brief requires. A second, documented fallback source is
specified for the settlement read.
**Trade-off:** The fallback adds design and test surface we would not otherwise carry, and a
fallback that disagrees with the primary is a judgment call we now have to define rather than
avoid. Accepted because settlement correctness is the headline graded metric: a single stale or
low-confidence feed at 4:05 PM would otherwise either block settlement entirely (failing the
liveness metric) or settle on a doubtful price (failing the correctness metric). Guards fail closed
— refusing to settle always beats settling wrong.

## 5. Full lifecycle plus polish, rather than a thin correctness slice

**Date:** 2026-10-05
**Context:** Scope choice for the submission. Options ranged from a bulletproof mint/settle/redeem
core with minimal UI, through full lifecycle with deliberate thinness, to full lifecycle with a
genuinely usable trading surface.
**Decision:** All ten functional requirements end to end, plus a usable trading UI, a portfolio
with realized P&L, and a market-maker dashboard.
**Trade-off:** Meaningfully more time than a core-only slice, and polish is explicitly not what the
brief grades. Accepted because the deliverables include a demo video of the full lifecycle, and
because the one-book/four-trade-path abstraction is a *user-facing* idea — it cannot be
demonstrated without a UI that actually presents Buy Yes / Buy No / Sell Yes / Sell No as four
plain actions. Tests still prioritize the money path and settlement over breadth.

## 6. RESOLVED — build a minimal in-program CLOB rather than integrate Phoenix

**Date:** 2026-10-05
**Status:** **Resolved by spike.** Full workings in
[`docs/spikes/2026-10-05-phoenix-devnet.md`](docs/spikes/2026-10-05-phoenix-devnet.md).
**Context:** The brief offers both paths: use an existing on-chain CLOB on the chosen chain (e.g.
Phoenix on Solana), or build a minimal order book as part of the smart contract — which the brief
calls "more ambitious, demonstrates deeper understanding". The spike was created to test the
assumption that Phoenix might not be usably available on devnet.

**The assumption was wrong, and the spike still went the other way.** Phoenix *is* deployed and
live on devnet (1,225 program accounts, ~700 market-sized, 474 seats). Integration was a real
option. Two other constraints decided it:

1. **Rent exceeds the devnet faucet, by an order of magnitude.** Phoenix market accounts run
   84,944–232,544 bytes. Meridian needs ~45 fresh markets *every trading day* (7 tickers × 5–7
   deduplicated strikes), which is 19–53 SOL/day in rent alone. The devnet faucet caps a request
   at ~2 SOL and rate-limits per day — a 10 SOL request is rejected outright. A reviewer could not
   reproduce the lifecycle, which the deliverables require and the brief forbids working around via
   mainnet.
2. **Phoenix seats are a maker-side permission gate.** Resting (limit) orders require an approved
   Seat, granted per trader per market by the market authority; takers swapping do not. With ~45
   markets a day, an active trader needs several seats daily, each a request plus an
   authority-signed approval. That is incompatible with FR-013 (Buy No market order must be one
   atomic operation, one user approval) and sits awkwardly against a product whose first premise is
   non-custodial and KYC-free.

**Decision:** Build a minimal central limit order book inside the Meridian program — price-time
priority, partial fills, cancellation, and the atomic mint-and-sell path behind Buy No.

**Trade-off:** We now own a matching engine, which is genuine work and the main schedule risk in
the project. Accepted because: it is the path the brief itself credits as demonstrating deeper
understanding; it keeps the system self-contained and devnet-reproducible; it removes an external
dependency, a CPI surface and a permissioning service; and because same-day expiry lets us **close
books at settlement and reclaim the rent**, something Phoenix's lifecycle does not offer. A compact
book at 128 orders/side costs ~3.8 SOL/day *recycled nightly*, against Phoenix's 19–53 SOL/day
consumed permanently.

**Consequence for the spec:** none. `specs/001-binary-outcome-markets/spec.md` deliberately states
the order book requirements (FR-009…FR-014) as *behaviour* — price-time priority, atomicity of the
Buy No path, real-time updates, settlement interaction — so it needed no rewriting when the spike
landed. The constitution's Stack & Scope Constraints should now be amended to record the closed
decision.

## 7. SUPERSEDES §4 — a guarded oracle *adapter*, with an attested devnet publisher as default

**Date:** 2026-10-05
**Status:** Decided, after verification. Full workings in
[`docs/spikes/2026-10-05-pyth-devnet.md`](docs/spikes/2026-10-05-pyth-devnet.md).
**Context:** Zach Gardner flagged in Slack that "Pyth on testnet is a dead end — the oracles haven't
been updated in MONTHS, and would require an api key providing access to stock data". §4 had assumed
Pyth would simply work on devnet. The claim was checked rather than taken on trust, and rather than
dismissed.

**Zach was right, and understated it.** Three measured findings:

1. **The legacy Pyth push feeds on devnet are years dead, not months.** 594 price accounts exist;
   the newest `valid_slot` among them is 322,338,253 against a current devnet slot of 507,978,643 —
   a gap of 185.6M slots, i.e. **2.4 to 3.5 years**. Sampled accounts carried `pub_slot = 1`.
2. **Hermes price reads return HTTP 401 for every asset class**, not just equities — tested META
   (equity) and BTC/USD (crypto) side by side, on both the old `hermes.pyth.network` and the new
   `pyth.dourolabs.app/hermes` endpoint. The feed *metadata* endpoint is still public, which is how
   all seven MAG7 feeds were confirmed to exist.
3. **The pull-oracle path is not itself dead.** The receiver program is deployed on devnet with
   739,203 `PriceUpdateV2` accounts. In the pull model the consumer posts a freshly signed update, so
   stale leftover accounts prove nothing — the only blocker is obtaining the signed blob, i.e.
   finding 2.
4. **The cause, and the real blocker: Pyth repriced equity data during 2026.** Andre pointed at
   Pyth's Core upgrade docs, which turned the measurement into an explanation. On **2026-06-15** Core
   deprecated extended-hours and session-based US equity feeds (~50 tickers including AAPL, TSLA,
   NVDA, META) to the paid Pyth Pro product; on **2026-07-31** regular-session equity feeds followed;
   on **2026-08-26** the whole Hermes API went behind an API key. The price list settles it: the free
   plan grants **no API access at all** (view-only, 10 s updates), Starter at $500/mo is **crypto
   only**, and the cheapest tier carrying MAG7 equities is **$5,000/month**.

   This is a deliberate three-step repricing, not an outage. **So "emailing Pyth support and asking
   nicely" will not produce a free equity key** — worth telling Zach so he does not block on a reply.
   The one cheap route that would work is an existing Pyth Pro entitlement at Peak6; that is a
   question for Myles Lewis, not for Pyth support.

**Decision:** Put the oracle behind an **adapter interface** — *return a price with a publish
timestamp and a confidence measure, or refuse* — with two implementations:

- **`AttestedPublisher`, the devnet default.** The automation service reads the close from a free
  stock API (Alpha Vantage: verified live, returns same-day data, needs only a free registered key),
  signs it, and posts it to a price account the program reads. The program applies the same guards as
  always — staleness under 5 minutes, confidence/quality, **plus a publisher allowlist** — and fails
  closed.
- **A second, independent free source as the tested fallback.** This slot was reserved for Pyth, and
  losing it produced a better design. Principle IV forbids a hardcoded confidence value, and a single
  source gives nothing honest to put there — but **two independent sources give us their
  disagreement**, which is a real uncertainty signal and exactly what the confidence guard was built
  to consume. Agreement means tight confidence and settlement proceeds; divergence past a threshold
  trips the guard and we fail closed rather than settle on a contested price. The fallback is now a
  genuine second opinion, and testable, which a $5,000/month dependency never could have been.
- **`PythAdapter`, written but not exercised.** Reads a `PriceUpdateV2` via the pull-oracle receiver.
  Kept because the pull path is genuinely alive and because it is the honest production answer — a
  real deployment of this product buys licensed market data. It MUST be labelled in code as untested
  against live data rather than presented as a working fallback.

**Trade-off:** We become our own oracle on devnet, which is a genuinely weaker trust model than an
oracle network, and self-attestation is the sort of thing that looks like cutting a corner if it is
not declared. Accepted, with mitigations rather than hand-waving: an on-chain publisher allowlist so
an unknown signer cannot settle markets; fail-closed guards so an absent publisher delays settlement
instead of corrupting it; and an explicit entry in the required risks-and-limitations note naming
this as a devnet limitation with Pyth as the production path. The alternative was never really
available: it is a $5,000/month subscription, not a favour that a support email might grant. The
adapter boundary still earns its keep — if Peak6 turns out to hold a Pyth Pro entitlement, we swap an
implementation rather than redesign settlement.

Left open for planning: the **divergence threshold** between the two sources that trips the
confidence guard. It must be set against real observed spread between the two feeds, not guessed. The
second free source (Finnhub, Twelve Data or Polygon end-of-day are the candidates) also still needs
probing the way Alpha Vantage was.

**Consequence for the spec:** one clause. `spec.md` describes the oracle only as "an external price
source" with guard *behaviour*, so nothing structural moved — but FR-019 listed two guards and now
lists three, gaining publisher attestation. (An earlier note here claimed "no change at all"; that
was one guard short.) Constitution Principle
IV named Pyth in one sentence and was amended to vendor-neutral wording (**v1.2.0**): the principle
now constrains the *property* — attested source, staleness bound, confidence check, fail closed,
allowlisted publisher — and the vendor choice lives here in the decision log where it can change
without a governance amendment. That is the second consecutive spike whose outcome landed without
rewriting the spec, for the same reason: requirements stated as behaviour, not mechanism.
