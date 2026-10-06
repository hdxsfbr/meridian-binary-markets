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
- A guarded price oracle behind a swappable adapter interface — staleness, confidence and publisher
  allowlist checks, failing closed. Pyth was evaluated and rejected on cost: MAG7 equity feeds are now
  a $5,000/month product and the free tier grants no API access. We sign prices from two independent
  free sources instead (Finnhub primary, Nasdaq cross-check, Alpha Vantage for the morning ladder),
  deriving the confidence measure from their disagreement. Total data cost $0. See `DECISIONS.md` §7
  and `docs/spikes/2026-10-05-pyth-devnet.md`.
- USDC integration (devnet test mint)
- Secrets via environment variables (`.env.example` committed)

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md) | **New to trading systems or Solana? Start here.** Explains the domain from scratch |
| [`docs/PRD.md`](docs/PRD.md) | Requirements FR-1…FR-10, merged from the portal brief and the partner PDF |
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
- Deployment guide with reproducible devnet scripts
- Test results (unit, integration, frontend and invariant tests)
- Demo video
- AI usage log

## Partner

Peak6 — PEAK6 Labs, the internal innovation and applied AI team, building Apex's Non-Traditional
Assets Platform (prediction markets, crypto trading, tokenization).
Technical contact: Myles Lewis (mlewis@peak6.com).

## Getting started

Setup instructions will be added as the project takes shape.
