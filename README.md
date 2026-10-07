# Meridian

Binary stock outcome markets on Solana. Gauntlet AI partner project for Peak6.

## Overview

Meridian is a non-custodial dApp for trading binary outcome contracts tied to the daily closing
prices of the MAG7 US equities (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA). Each contract asks
whether a stock will close **at or above** a strike price. Contracts are same-day expiry (0DTE).
Yes/No tokens settle at $1 USDC if correct and $0 if wrong, so max gain and loss are both known at
entry. No KYC, no custody, no margin.

**The $1.00 invariant:** Yes payout + No payout = exactly $1.00 USDC, for every contract, always.
Ties go to Yes — the rule is at-or-above.

## Scope

- Automated daily market creation for all 7 tickers (±3/6/9% strikes from the previous close,
  rounded to the nearest $10, deduplicated)
- Minting and redemption of Yes/No token pairs, preserving the $1.00 payout invariant
- One central limit order book per strike (Yes vs USDC) with real-time updates
- Four first-class trade paths — Buy Yes, Buy No, Sell Yes, Sell No — on that single book
- Wallet integration, position management, realized P&L, market-maker dashboard
- Automated settlement via a guarded price oracle, with redemption open indefinitely

### One book, two perspectives

The central architectural idea: each strike has **exactly one order book** — the Yes token traded
against USDC. Because Yes + No = $1.00, selling a Yes is economically identical to buying a No, so
no separate No book is needed. Buy Yes and Sell No are the same side of the book; Buy No and Sell
Yes are the other. The frontend presents four plain actions and translates intent into the correct
book operation.

## Daily lifecycle (ET)

| Step | Time |
| --- | --- |
| Strikes calculated from previous close | 8:00 AM |
| Contracts and order books created | 8:30 AM |
| Markets visible, minting enabled | 9:00 AM |
| Trading open | 9:30 AM to 4:00 PM |
| Settlement | ~4:05 PM (within 10 min of close) |
| Redemption | from 4:05 PM, indefinitely |

## Targets

- 100% settlement accuracy; the $1.00 invariant never violated
- Sub-second transaction finality
- Oracle price staleness under 5 minutes, plus confidence and publisher-attestation checks — guards
  fail closed
- Full lifecycle demo reproducible on devnet: create → mint → trade → settle → redeem

## Stack

- Solana programs in Rust with Anchor — **devnet deployment is required to pass**; never mainnet,
  never real funds. (EVM L2s such as Arbitrum or Base were acceptable alternatives per the brief;
  see `DECISIONS.md` §3 for why Solana.)
- Frontend in TypeScript, React and Next.js
- Node.js automation service for market creation and settlement
- **Pyth** price oracle behind a guarded provider interface — staleness, confidence and
  publisher-attestation checks, failing closed. Pyth's equity feeds require a Pyth Pro token we are
  arranging; until it arrives the service runs a Pyth-shaped mock provider that posts a signed price
  from a free stock API through the same interface and guards. The provider is a config switch.
  See `DECISIONS.md` §4 and `docs/spikes/2026-10-05-pyth-devnet.md`.
- USDC integration (devnet test mint)
- Secrets via environment variables (`.env.example` committed)

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md) | **New to trading systems or Solana? Start here.** Explains the domain from scratch |
| [`docs/PRD.md`](docs/PRD.md) | Requirements FR-1…FR-12, merged from the portal brief and the partner PDF |
| [`docs/Gauntlet-Project-Meridian.pdf`](docs/Gauntlet-Project-Meridian.pdf) | The partner's original brief |
| [`docs/spikes/`](docs/spikes/) | Investigations behind specific decisions |
| [`.specify/memory/constitution.md`](.specify/memory/constitution.md) | Engineering principles governing the project |
| [`specs/001-binary-outcome-markets/spec.md`](specs/001-binary-outcome-markets/spec.md) | Feature specification |
| [`DECISIONS.md`](DECISIONS.md) | Running decision log with trade-offs |
| [`AI_USAGE.md`](AI_USAGE.md) | AI usage log (required deliverable) |

## Development

Spec-driven, using [GitHub spec-kit](https://github.com/github/spec-kit) with the Claude Code
integration:

```
/speckit-constitution  →  /speckit-specify  →  /speckit-plan  →  /speckit-tasks  →  /speckit-implement
```

Commits reference the requirement they advance, e.g. `FR-5: oracle settlement with staleness check`.

## Deliverables

- Source code
- Technical documentation (including a risks/limitations note, with no regulatory or compliance
  claims)
- Deployment guide with reproducible devnet scripts and one-command setup
- Test results (unit, integration, frontend and invariant tests)
- Demo video
- AI usage log

## Partner

Peak6 — PEAK6 Labs, the internal innovation and applied AI team, building Apex's Non-Traditional
Assets Platform (prediction markets, crypto trading, tokenization).
Technical contact: Myles Lewis (mlewis@peak6.com).

## Getting started

The toolchain is a pinned Docker image rather than a host install — Anchor's
anchor/solana-cli/rustc version triple breaks obscurely when mismatched, and the devnet lifecycle has
to be reproducible by a reviewer with no manual steps. See `DECISIONS.md` §7.

```
make dev
```

is the one command: it builds the image, installs the pnpm workspace, builds the Anchor program,
runs the program test suite on LiteSVM, starts `solana-test-validator`, deploys the program to it,
and serves the web placeholder on `http://localhost:3000`. Nothing else needs to be installed on the
host except Docker. On Apple Silicon the image runs under x86_64 emulation (Agave publishes no
linux/arm64 installer), so builds and the validator are slower than on an x86_64 host.

## Toolchain

Verified by running `make dev` from a clean checkout (image rebuilt from scratch, no cached
volumes) on 2026-10-06:

| Tool | Version | Notes |
|---|---|---|
| Rust | `rustc 1.89.0 (29483883e 2025-08-04)` | pinned, unchanged from plan |
| Anchor CLI | `anchor-cli 1.2.1` | installed from the prebuilt release binary, matching the plan's first choice and the `anchor-lang`/`anchor-spl` crates the program depends on — see `DECISIONS.md` §7 |
| Agave (Solana) CLI | `solana-cli 3.1.14 (src:3134055b; feat:534737035, client:Agave)` | pinned, unchanged from plan |
| Node.js | `v22.23.3` | Node 22 LTS, installed as an exact version pin |
| pnpm | `10.0.0` | via Corepack, baked into the image so no network call is needed at container start |

The base image moved from `rust:1.89-bookworm` to `rust:1.89-trixie` (newer glibc), the program
builds with `anchor build --arch v1` instead of the default `v3`, and `compose.yml` runs the `dev`
service with `security_opt: [seccomp:unconfined]` so `solana-test-validator` can start. None of these
change the Rust/Anchor/Agave/Node/pnpm pins above — see `DECISIONS.md` §7, 2026-10-06, for why each
was needed.
