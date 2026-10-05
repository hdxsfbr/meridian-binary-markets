# Meridian

Binary stock outcome markets on Solana. Gauntlet AI partner project for Peak6.

## Overview

Meridian is a non-custodial dApp for trading binary outcome contracts tied to the daily closing prices of the MAG7 US equities (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA). Each contract asks whether a stock will close above a strike price. Yes/No tokens settle at $1 USDC if correct and $0 if wrong, so max gain and loss are known at entry.

## Scope

- Automated daily market creation for all 7 tickers
- Minting and redemption of Yes/No token pairs (the $1.00 payout invariant must always hold)
- Central limit order book with real-time updates
- Wallet integration and position management
- Automated settlement via a price oracle

## Daily lifecycle (ET)

| Step | Time |
| --- | --- |
| Markets created | by 8:00 AM |
| Trading open | 9:30 AM to 4:00 PM |
| Settlement | by 4:05 PM (within 10 min of close) |

## Targets

- 100% settlement accuracy
- Sub-second transaction finality
- Oracle price staleness under 5 minutes
- Full lifecycle demo on testnet

## Stack

- Solana programs in Rust with Anchor
- Frontend in TypeScript, React and Next.js
- Node.js automation service for market creation and settlement
- Price oracle and USDC integration
- Secrets via environment variables

## Deliverables

- Source code
- Technical documentation
- Deployment guide
- Test results (unit, integration, frontend and invariant tests)
- Demo video
- AI usage log

## Getting started

Setup instructions will be added as the project takes shape.
