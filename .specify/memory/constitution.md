<!--
Sync Impact Report
- Version change: (none) → 1.0.0 (initial adoption)
- Modified principles: n/a (initial adoption)
- Added sections: Core Principles (I–VII), Stack & Scope Constraints, Development Workflow,
  Governance
- Removed sections: none
- Template note: the resolved scaffold carries five principle slots; the project defines seven,
  per the explicit instruction that a stated principle count wins over the template default.
- Follow-up TODOs: the CLOB decision (build minimal in-program order book vs integrate Phoenix)
  is deliberately DEFERRED pending a time-boxed spike. See Stack & Scope Constraints. This is a
  recorded open decision, not an unfilled placeholder.
-->

# Meridian Constitution

Gauntlet partner project for Peak6: a non-custodial Solana dApp for trading binary outcome
contracts on the daily closing prices of the MAG7 US equities. Each contract asks whether a stock
closes at or above a strike; Yes and No tokens settle at $1.00 USDC and $0.00. See `docs/PRD.md`
for requirements (FR-1…FR-10) and the authoritative lifecycle, `docs/Gauntlet-Project-Meridian.pdf`
for the partner's original brief, and `DECISIONS.md` for the decision log.

## Core Principles

### I. The $1.00 Invariant Above All (NON-NEGOTIABLE)

For every contract, Yes payout + No payout MUST equal exactly $1.00 USDC. Always. There is no
rounding tolerance and no exception.

- All value MUST be carried as integer base units (USDC micro-units, 6 decimals) end to end — no
  floats, no decimal strings doing arithmetic, on-chain or off.
- Settlement uses the **at-or-above rule**: `close >= strike` means Yes wins. Exact ties go to Yes.
- Minting and redemption are strictly pair-wise and MUST conserve collateral: USDC held by the
  contract MUST always equal the number of outstanding Yes/No pairs × $1.00.
- The invariant MUST be enforced on-chain in the program, not merely in the client. A client-side
  check is a convenience, never the guarantee.
- The money path MUST be covered by invariant tests including tie cases (`close == strike`),
  dust and rounding edges, partial redemption, and redemption after settlement.

Rationale: correctness here is the single graded metric the partner states in absolute terms —
100% of settlements pay the correct side, and the invariant is never violated.

### II. Mirror the Partner's Recommended Stack

Solana with Rust and the Anchor framework for on-chain programs; TypeScript with React and Next.js
for the frontend; TypeScript and Node.js for the automation service.

- Deployment to **Solana devnet is required to pass**, with reproducible scripts.
- **Never mainnet. Never real funds.** Not for demos, not for convenience.
- Secrets MUST come from environment variables, with a committed `.env.example`.
- Avoid unnecessary third-party abstractions. Every major dependency MUST be justified in
  `DECISIONS.md`.

Rationale: the brief names Solana as recommended and Rust/TypeScript as required languages; the
reviewer is Peak6 Labs, who build on this terrain. Work in their stack is directly legible.

### III. Non-Custodial, One Book, Two Perspectives

The protocol MUST never take custody. Users hold their own tokens and USDC, and every state
change is a user-signed transaction.

- Each strike has **exactly one order book**: the Yes token traded against USDC. There is no
  separate No book — the No perspective is the inverse of the Yes book.
- The four user actions (Buy Yes, Buy No, Sell Yes, Sell No) are each first-class UI actions,
  translated by the frontend into the correct book operation. The user is never asked to
  understand the mechanic.
- A Buy No market order MUST be one atomic transaction and one wallet approval (mint pair, sell
  Yes at best bid, keep No). Partial execution that leaves the user holding an unintended position
  is a defect.
- The UI MUST prevent persistent simultaneous Yes and No positions in the same strike. Holding
  both is legitimate only as a transient state inside the mint-pair operation; the UI checks
  balances before offering trades and guides the user to exit the opposing position first.

Rationale: the one-book abstraction is the central architectural idea in the brief, and the
partner calls it out as such. Getting it right is the difference between implementing the spec and
reciting it.

### IV. Oracle Reads Are Guarded

Pyth is the primary price source, with a documented fallback for the settlement read.

- Every on-chain oracle read MUST enforce a staleness bound (under 5 minutes) and a
  confidence/quality check.
- Guarded reads MUST **fail closed**: a stale or low-confidence price blocks settlement rather
  than settling wrong. Delayed settlement is a liveness miss; wrong settlement is a correctness
  failure, and correctness outranks liveness.
- The fallback path MUST be explicit, documented, and tested — not an untested escape hatch.
- Settlement MUST be idempotent and replay-safe: a contract settles exactly once, and a repeated
  settlement transaction is a no-op rather than a second payout.

Rationale: the oracle is the only place real-world truth enters the system, and it is the only
place where a silent failure converts directly into paying the wrong side.

### V. The Daily Lifecycle Is The Product

The automation service MUST reliably drive the ET schedule: 8:00 AM strikes calculated, 8:30 AM
contracts and books created, 9:00 AM markets visible and minting enabled, 9:30 AM trading open,
4:00 PM close, ~4:05 PM settlement, redemption open from then on indefinitely.

- Strike generation MUST follow the PRD algorithm: ±3%, ±6%, ±9% from the previous close, rounded
  to the nearest $10, **deduplicated**, with the rounded previous close available as an additional
  strike.
- The full lifecycle — create → mint → trade → settle → redeem — MUST be reproducible on devnet
  from scripts, by a reviewer, with no manual steps.

Rationale: the brief grades liveness and operability as named metrics, and a lifecycle a reviewer
cannot reproduce unaided has not actually been demonstrated.

### VI. Decisions Documented as They Happen

`DECISIONS.md` (Date / Context / Decision / Trade-off) and `AI_USAGE.md` MUST be updated
continuously as decisions are made and AI is used — not reconstructed at the end.

- Both are graded deliverables.
- The chain, oracle, and CLOB choices each require written rationale with trade-offs.
- A short risks and limitations note is required, making **no regulatory or compliance claims**.
- Candor is required: record where AI helped, where it misled, and where it was overridden.

Rationale: the brief grades documented rationale explicitly, and in-the-moment logs are the honest
version.

### VII. Depth Where It Demonstrates Understanding

Full lifecycle plus polish: all ten functional requirements end to end, with a genuinely usable
trading UI, a portfolio view with realized P&L, and a market-maker dashboard.

- Tests target the money path, settlement, and the trade-path translation layer first.
- Coverage is never pursued for its own sake; effort goes where a defect would be expensive or
  where the work demonstrates understanding.
- Where scope is cut, the cut MUST be documented rather than silently dropped.

## Stack & Scope Constraints

- **Monorepo layout:** `programs/` (Anchor, Rust), `web/` (Next.js + TypeScript), `services/`
  (Node.js automation service).
- **Underlying assets:** 7 MAG7 tickers — AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA.
- **Settlement asset:** USDC on devnet (mock/test mint).
- **V1 scope:** same-day expiry (0DTE) contracts only. No multi-day, no American-style early
  exercise, no cross-strike netting.
- **Performance targets:** sub-second transaction finality, settlement within 10 minutes of market
  close, real-time order book updates, oracle price staleness under 5 minutes.
- **OPEN DECISION — CLOB implementation.** Whether to build a minimal in-program order book or to
  integrate an existing on-chain CLOB (Phoenix) is **DEFERRED** pending a time-boxed spike that
  verifies Phoenix devnet availability and CPI ergonomics. The spike outcome MUST be recorded in
  `DECISIONS.md` before planning completes. If the outcome changes the stack constraints above,
  this constitution MUST be amended first.

## Development Workflow

- Spec-driven: `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`,
  with generated artifacts pruned for brevity rather than accepted verbatim.
- Invariant and settlement tests MUST land and pass before UI work builds on top of them.
- Commits reference the FR they advance (e.g. `FR-5: oracle settlement with staleness check`).

## Governance

This constitution governs scope and engineering judgment calls for the project. When a proposed
change conflicts with a principle, either the change is rejected or the principle is amended here
first, with the amendment logged in `DECISIONS.md`.

Versioning follows semver: MAJOR for principle removals or redefinitions, MINOR for new or
materially expanded principles, PATCH for clarifications. Compliance review is lightweight: before
implementation starts and again before submission, verify the $1.00 invariant tests pass, the
guarded-oracle behaviour is tested including the fallback, the devnet lifecycle is reproducible
from scripts, and the decision and AI usage logs are current.

**Version**: 1.0.0 | **Ratified**: 2026-10-05 | **Last Amended**: 2026-10-05
