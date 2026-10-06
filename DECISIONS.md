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

## 4. Oracle: RedStone as the on-chain price source, behind a guarded adapter

**Date:** 2026-10-05, settled 2026-10-06
**Evidence:** [`docs/spikes/2026-10-05-pyth-devnet.md`](docs/spikes/2026-10-05-pyth-devnet.md) — all
quantitative claims there are reproducible from the recorded calls.
**Context:** The brief requires an oracle that supplies the previous day's close (for the morning
strike ladder) and the day's close at 4:00 PM ET (for settlement), is readable on-chain during the
settlement transaction, and supports both a **staleness check** and a **confidence/quality check**.
The choice must be justified.

**Decision — two parts, and the first matters more than the second.**

**(a) The oracle sits behind an adapter interface:** *return a price with a publish timestamp and a
confidence measure, or refuse.* The program applies four guards to whatever comes back — staleness
under 5 minutes, confidence/quality, publisher attestation, and fail-closed on any failure. This is
the load-bearing decision. It has survived three changes of price source without the spec or the
architecture moving, and Constitution Principle IV deliberately names no vendor for that reason.

**(b) The source is RedStone**, with a self-attested publisher as the tested fallback.

| Role | Implementation |
|---|---|
| Primary | **RedStone** pull oracle — devnet `REDuYsnEucMweattdv4xQCYdU1i8Q2W92kdayrpY9rA` |
| Fallback | Our own signed publisher, reading a free stock API (Finnhub primary, Nasdaq cross-check) |

Verified rather than assumed: the devnet program is executable and **actively fed** (accounts written
3.2 h ago, against Pyth's legacy feeds at ~2.4 years); all seven MAG7 are in the live 996-feed
production package with regular-session, 24/7, extended and pre/after variants; and each feed carries
**five independently signed values** — AAPL spread 0.0016%, MSFT 0.024% — all signatures valid, 22 s
old, served unauthenticated.

**Why RedStone beats the alternatives.** Pyth is unusable: its legacy devnet feeds are years dead and
MAG7 equities are now a **$5,000/month** product, with the free tier granting no API access at all.
Stork returns HTTP 401 with undocumented pricing. **Switchboard ceased all operations on 2026-09-25**
— its devnet program is still `executable`, which is exactly why "deployed" was never accepted as
evidence here. RedStone is the only candidate that is free, live on devnet, and carries the feeds.

And it is *better*, not merely cheaper: five signed opinions with a configurable on-chain unique-signer
threshold is a **cryptographically attested** confidence measure. Pyth supplies one pre-computed
interval; a self-run publisher supplies nothing honest at all, which is why Principle IV forbids
hardcoding one. RedStone means we are not our own oracle.

**Trade-off.** RedStone adds an external dependency and secp256k1 signature verification inside the
settlement path — compute budget and integration work a self-run publisher would avoid. Accepted,
because "we are our own oracle" was the weakest claim in the design and the one a reviewer would press
hardest on. The fallback keeps the self-attested path built and tested, which Principle IV requires
anyway, so the dependency is not load-bearing.

**Open item.** RedStone's docs state the pull model requires an API key, while the gateway currently
serves data without one. The key comes from a four-question Google Form (email, company, feeds,
Telegram) with **no payment step, no pricing and no plan selection** — a registration gate, not a
commercial one, and structurally unlike Pyth's published price list. Andre to submit it so access is
durable; until then the open gateway works and the fallback covers total RedStone failure.

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
