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

## 6. OPEN — order book: build minimal in-program, or integrate Phoenix?

**Date:** 2026-10-05
**Status:** **Deferred pending a time-boxed spike.** Must be resolved and recorded here before
planning completes.
**Context:** The brief offers both paths explicitly: use an existing on-chain CLOB already deployed
on the chosen chain (e.g. Phoenix on Solana), or build a minimal order book as part of the smart
contract — which the brief calls "more ambitious, demonstrates deeper understanding". The
complication is that Phoenix is a mainnet protocol, and the brief simultaneously requires a
reproducible **devnet** lifecycle and forbids mainnet. If Phoenix is not usably available on
devnet, integrating it cannot satisfy the deliverable.
**Spike:** Verify Phoenix devnet availability and CPI ergonomics, time-boxed. Commit to a path
immediately afterward and record the outcome here.
**Trade-off either way:** Building the book means writing and testing a matching engine — real
work, and the main risk to the schedule — but keeps the system self-contained, devnet-reproducible,
and scores on the brief's own "deeper understanding" note. Integrating Phoenix removes the matching
engine but adds an external dependency, CPI complexity, and the devnet availability risk above.
**Handling until resolved:** `specs/001-binary-outcome-markets/spec.md` states the order book
requirements (FR-009…FR-014) as *behaviour* — price-time priority, atomicity of the Buy No path,
real-time updates, settlement interaction — so the spec commits to neither mechanism and does not
need rewriting once the spike lands.
