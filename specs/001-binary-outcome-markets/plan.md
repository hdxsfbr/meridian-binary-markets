# Implementation Plan: Binary Stock Outcome Markets

**Branch**: `main` (the project works on main; spec-kit's feature directory is
`specs/001-binary-outcome-markets/`) | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-binary-outcome-markets/spec.md`, PRD FR-1…FR-12,
`DECISIONS.md` §3, §4, §6, §7, constitution v1.4.0.

## Summary

Daily binary outcome markets on the MAG7 closes: one Anchor program holding mint/redeem, a
price-time order book per strike, guarded settlement behind an oracle provider interface, admin
override and pause; a Node automation service running the ET schedule; a Next.js app with the five
PRD pages. Pyth is the price source behind the interface, read through a Pyth-shaped mock provider
until the Pyth Pro key arrives, then through Pyth's devnet receiver. Everything builds, tests and
deploys from one pinned container via `make dev`.

## Technical Context

**Language/Version**: Rust 1.89 (program), TypeScript 5.x on Node 22 LTS (service, web, tests)

**Primary Dependencies**: Anchor 1.2.1 (`anchor-lang`, `anchor-spl`), `pyth-solana-receiver-sdk`
2.0.0, `bytemuck`; `@anchor-lang/core` 1.2.1, `@solana/web3.js` 1.99, `@solana/wallet-adapter-react`
0.15.40, Next.js 16.4, Tailwind, Luxon, `node-cron`, `@pythnetwork/pyth-solana-receiver` (service
only); `anchor-litesvm` 0.2.1, Vitest, Playwright. Each is justified in `research.md` R1–R3, R14.

**Storage**: On-chain accounts only (Config, Market, Book, MockPriceUpdate, SPL mints and token
accounts). No database; positions and P&L are derived from program events in the browser (R11).

**Testing**: Program unit tests on LiteSVM with clock warping; integration lifecycle script against
`solana-test-validator` and devnet; Vitest for the intent translation layer; Playwright smoke flows.

**Target Platform**: Solana devnet (never mainnet, DECISIONS §3); Linux container for all tooling;
browser for the web app.

**Project Type**: Monorepo: on-chain program + Node service + web app + shared SDK + scripts.

**Performance Goals**: Book changes visible to all clients within 1 s (SC-008); settlement of all
markets within 10 min of close, in practice inside the 16:00–16:05 window (R4); every instruction under
the 200k CU default, matching capped at 8 fills per transaction.

**Constraints**: Integer micro-units only on the money path; staleness ≤ 300 s; confidence guard;
publisher allowlist; fail closed; override ≥ 3600 s after close; pause never blocks redemption;
demo-scale configuration (full ladder, 16-order book) fits one ~2 SOL airdrop (R7); no host toolchain (§7); no
implementation commentary in product UI.

**Scale/Scope**: 7 tickers × 5–7 strikes ≈ 45 markets/day at every scale; book
capacity 16 (demo) or 128 orders per side; five product pages plus an admin page; ~17 instructions.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How the design satisfies it | Status |
|---|---|---|
| I. $1.00 invariant | `u64` micro-units everywhere; `mint_pair`/`redeem_pair`/`redeem_winning` assert the vault equation in code and fail with `InvariantViolated`; at-or-above comparison on integers; LiteSVM tests cover tie, dust, partial and post-settlement redemption | PASS |
| II. Partner stack | Rust + Anchor, TypeScript + React/Next.js, Node service; devnet deploy scripted; `.env.example` committed; each dependency justified in `research.md` | PASS |
| III. Non-custodial, one book | Users sign every change; escrows and vault are program PDAs released only by the user's own instruction or settlement; one `Book` per market (Yes vs USDC); `buy_no_market` is one instruction and redeems unfilled pairs so no unintended position survives; UI gating per `contracts/frontend.md`; `pause` leaves `redeem_pair`, `redeem_winning`, `cancel_order` callable | PASS |
| IV. Guarded oracle | Provider interface in `contracts/oracle-provider.md`: owner check, parse, attestation, then four common guards, fail closed; two implementations (`MockPyth`, `PythReceiver`) both tested; confidence is Pyth's published interval or two-source disagreement, never a constant; override admin-only after ≥ 3600 s, tested with clock warp; idempotent settle (`AlreadySettled`); mock's weaker trust model goes in the risks note naming Pyth as the production path | PASS |
| V. Daily lifecycle | `contracts/automation.md` schedules 08:00 ladder, 08:30 creation, 16:00:30 settlement, with the PRD strike algorithm as a pure tested function; `make lifecycle CLUSTER=devnet` reproduces create → mint → trade → settle → redeem unaided | PASS |
| VI. Decisions as they happen | This plan introduces no new vendor; implementation decisions (e.g. a pin change) go to `DECISIONS.md` once, when made; `AI_USAGE.md` entry per working session | PASS |
| VII. Depth | Full lifecycle plus trading UI, portfolio with realized P&L, market-maker view; tests concentrated on money path, settlement and translation layer; any cut recorded | PASS |
| Stack & Scope: in-program CLOB, rent reclaimed, bounded capacity and compute | Variable-capacity `Book`, `BookFull` on overflow, 8-fill cap with well-defined remainder, `close_book`/`close_market` after settlement | PASS |
| Stack & Scope: oracle entry (Pyth target, mock devnet-only, config switch) | `Config.oracle_provider`; service refuses `mock` off devnet/localnet; `update_config` switches provider without redeploy | PASS |

No violations; Complexity Tracking is empty.

**Post-design re-check (after Phase 1)**: unchanged. One point worth stating: reading a
`PriceUpdateV2` our own service posted is not "being our own oracle" because the receiver program
verifies Wormhole guardian signatures over Pyth's aggregate before the account can exist; our program
checks the owner and `VerificationLevel::Full`. The mock path is weaker and is disclosed.

## Project Structure

### Documentation (this feature)

```text
specs/001-binary-outcome-markets/
├── plan.md              # This file
├── research.md          # Phase 0: pins, Pyth feeds and timing, USDC, book, trade paths, timing, tests
├── data-model.md        # Phase 1: accounts, events, invariants, validation rules
├── quickstart.md        # Phase 1: make dev and the six validation scenarios
├── contracts/
│   ├── program-instructions.md
│   ├── oracle-provider.md
│   ├── automation.md
│   └── frontend.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
Makefile                     # dev, test-program, lifecycle, deploy, jobs, web, test-web
Dockerfile                   # rust:1.89-bookworm + Agave 3.1.14 + Anchor 1.2.1 + Node 22 + pnpm
compose.yml                  # dev container, named volumes for target/ and ~/.cargo, keys mounted ro
.devcontainer/devcontainer.json
.env.example
Anchor.toml  Cargo.toml  package.json  pnpm-workspace.yaml  tsconfig.base.json

programs/meridian/
└── src/
    ├── lib.rs               # declare_id, #[program] with the instructions in contracts/program-instructions.md
    ├── state/               # config.rs, market.rs, book.rs (header + bytemuck order slices), mock_price.rs
    ├── instructions/        # one file per instruction
    ├── oracle/              # mod.rs (read_quote + guards), pyth.rs, mock.rs
    ├── book/                # matching.rs (price-time, 8-fill cap), escrow.rs
    ├── events.rs  errors.rs  math.rs (checked micro-unit helpers)

packages/sdk/                # shared TS: generated IDL types, PDA derivation, Book decoder,
└── src/                     # strike ladder (pure), intent.ts translation layer, event parsing, P&L

services/automation/
└── src/
    ├── index.ts             # cron entry
    ├── jobs/                # morning.ts, settle.ts, publisher.ts, reclaim.ts
    ├── providers/           # PriceProvider, MockPythProvider, PythReceiverProvider
    ├── sources/             # finnhub.ts, nasdaq.ts, hermes.ts
    ├── calendar.ts          # ET trading days, close_ts, holidays from feed schedule
    ├── alert.ts  log.ts
    └── probe/pyth.ts        # R5 token-day probe

web/                         # Next.js 16 App Router
└── src/
    ├── app/                 # page.tsx, markets/, trade/[ticker]/, portfolio/, history/, admin/
    ├── components/          # TradePanel, BookView (Yes + No perspective), ContractCard, Countdown, …
    ├── hooks/               # useBook (ws subscription), usePositions (events), useConfig
    └── lib/                 # wallet adapter setup, rpc

scripts/                     # deploy.ts, init-config.ts, lifecycle.ts, airdrop.ts, rent-estimate.ts
tests/
├── program/                 # LiteSVM suites: invariant, oracle, settle, override, pause, book, trade-paths
├── integration/             # lifecycle against local validator
└── web/                     # Playwright smoke flows
```

**Structure Decision**: Monorepo with pnpm workspaces (`packages/sdk`, `services/automation`, `web`,
`tests`) and a single Anchor workspace for `programs/meridian`. One program rather than two
(markets + book) because every trading path composes mint/redeem with matching atomically, and a CPI
boundary would add accounts and compute for no isolation benefit at this size.

## Phase ordering for /speckit-tasks

1. **Container and skeleton** (DECISIONS §7): Dockerfile, compose, Makefile, devcontainer, Anchor and
   pnpm workspaces, a hello-world program that builds and a LiteSVM test that passes. Gate: `make dev`
   green on a clean machine. Only then does any product code start.
2. **Money path**: Config, Market, mint_pair, redeem_pair, invariants, tests including ties and dust.
3. **Oracle and settlement**: provider interface, mock provider and `mock_write_price`, guards,
   settle_market, admin_settle_override, pause/unpause, LiteSVM clock tests.
4. **Order book**: Book account, place_order, cancel_order, matching, escrow, BookFull, 8-fill cap.
5. **Trade paths**: buy_no_market, buy_no_limit, sell_no_market; redeem_winning; close_book/market.
6. **SDK**: IDL client, PDAs, Book decoder, strike ladder, intent translation with Vitest.
7. **Automation**: calendar, sources, MockPythProvider, jobs, alerting, CLI, demo `--day` path.
8. **Scripts and devnet**: deploy, init, lifecycle, rent estimate, demo-scale config; first devnet run.
9. **Web**: pages in PRD order, book subscription, trade panel with gating, portfolio and history from
   events, admin page; Playwright smoke flows.
10. **Pyth token day** (R5, can run any time the key exists): probe, PythReceiverProvider, program
    `pyth.rs` arm tested against a real posted update, `update_config --provider pyth`.
11. **Docs**: README one-command setup, deployment guide, architecture, risks and limitations note,
    `DECISIONS.md`/`AI_USAGE.md` current, demo video script.

Phases 6–9 can proceed in parallel with each other once 2–5 exist; 10 is independent of 9.

## Risks carried into tasks

| Risk | Mitigation in the plan |
|---|---|
| Pyth equity feed stops at the bell; 5-minute staleness makes 16:00–16:05 the only window | Settlement job at 16:00:30 with 30 s retries; probe measures real drift; override at 17:00 (R4) |
| Anchor 1.2.1 released today | Pin, verify in phase 1, fall back to 1.2.0 |
| Devnet public RPC websocket limits | RPC URL is an env variable; README names free devnet RPC providers |
| Faucet rate limit on a reviewer's first day | Demo scale (full ladder, book capacity 16, ~1.25 SOL) is the default in `make lifecycle CLUSTER=devnet`, rent printed before spend |
| Matching engine is the main schedule risk (DECISIONS §6) | Capacity-bounded arrays, 8-fill cap, tests first; UI can ship against limit-only books if time is short, recorded as a cut |
| Mock provider is a trust model weaker than production | Disclosed in risks note; swap is a config change |

## Complexity Tracking

No constitution violations to justify.
