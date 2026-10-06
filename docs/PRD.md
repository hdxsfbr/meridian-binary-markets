# PRD — Meridian: Binary Stock Outcome Markets on Blockchain (Peak6)

> Mirrors the project brief on the Gauntlet portal
> (https://portal.gauntletai.com/projects/IJ1Pjp6wG7sdm1WKENVW), Version 1, last updated
> 8/7/2026, merged with the fuller spec in `docs/Gauntlet-Project-Meridian.pdf` and restructured
> as a working PRD with requirement IDs we can trace commits and tests back to.
> Partner: Peak6 (investment firm; PEAK6 Labs builds Apex's Non-Traditional Assets Platform —
> prediction markets, crypto, tokenization) · Tier: Platinum · Technical contact: Myles Lewis
> (mlewis@peak6.com).
>
> Where the portal brief and the PDF differ in detail, the PDF is the more specific source and
> wins; nothing in the two actually conflicts.

## 1. Problem

Retail participants who want to express a directional view on a stock today reach for options,
which carry Greeks, margin calls, assignment risk and unbounded downside. The mental model is
expensive to acquire and the risk is hard to bound.

Binary outcome markets answer one question — *"Will META close above $680 today?"* — with a
payout of $1.00 or $0.00. Max gain and max loss are both known at entry. No Greeks, no margin
calls, no unlimited downside.

Applying that structure to daily stock closes creates a familiar, high-frequency product. Building
it on a high-performance blockchain with a non-custodial architecture (user wallets, on-chain
order book, oracle settlement) removes intermediaries and makes the whole system transparent and
auditable.

## 2. Goal

Design and build a non-custodial dApp for trading binary outcome contracts tied to the daily
closing prices of the MAG7 US equities. Contracts are same-day expiry (0DTE) and settle at
4:00 PM ET against an on-chain price oracle. Users trade two complementary token types — **Yes**
and **No** — on an on-chain order book. **No KYC, no custody, no margin.**

**Impact metrics (from the brief):**

| Dimension | Target |
|---|---|
| Correctness | 100% of settlements pay the correct side; the $1.00 invariant is never violated |
| Liveness | Markets created before market open and settled within 10 minutes of close, every trading day |
| Operability | Full lifecycle demo reproducible on testnet: create → mint → trade → settle → redeem |
| Documentation | Clear rationale for all architecture and chain decisions; trade-offs explained |

## 3. Core concepts

### 3.1 The contract

A Meridian contract is a pair of complementary tokens — **Yes** and **No** — representing a binary
outcome tied to a stock's closing price relative to a strike level on a given trading day.

- **Yes token:** pays $1.00 USDC if the stock closes **at or above** the strike; $0 otherwise.
- **No token:** pays $1.00 USDC if the stock closes **below** the strike; $0 otherwise.
- **Invariant:** Yes payout + No payout = $1.00 USDC. Always. For every contract.

Ties go to Yes — the rule is *at or above*. For "META closes above $680 today": close $685 → Yes
$1.00 / No $0.00; close $675 → Yes $0.00 / No $1.00; close exactly $680 → Yes $1.00 / No $0.00.

Because Yes + No = $1.00, if Yes trades at $0.65 then No is implicitly worth $0.35, and the Yes
price approximates the market-implied probability of closing at or above the strike.

### 3.2 One book, two perspectives

**The most important architectural concept in Meridian.** Each strike has **exactly one order
book**: the Yes token traded against USDC. Selling a Yes token is economically identical to buying
a No token, so the book needs no separate No side — the No perspective is the inverse of the Yes
book.

Four user actions on one book:

| Action | Mechanic | Book side |
|---|---|---|
| **Buy Yes** | Buy Yes tokens from the ask side | buying Yes |
| **Buy No** | Mint a Yes/No pair ($1.00 USDC), sell the Yes on the bid side, keep the No. Effective No cost = $1.00 − Yes sale price | selling Yes |
| **Sell Yes** | Sell Yes tokens on the ask side, receive USDC | selling Yes |
| **Sell No** | Buy a Yes token from the ask side; now holding Yes + No = $1.00 redeemable | buying Yes |

Buy Yes and Sell No are the same side of the book. Buy No and Sell Yes are the same side. One
book, four user actions, two perspectives.

**UX abstraction:** the frontend shows plain "Buy Yes" / "Sell Yes" / "Buy No" / "Sell No"
buttons and translates intent into the correct book action. The user never needs to know that Buy
No is a mint-and-sell-Yes operation.

### 3.3 Strike selection

Each morning before market open, the automation service creates strikes per stock at percentage
intervals around the previous close, rounded to the nearest $10:

1. Read previous closing price from the oracle.
2. Generate strikes at ±3%, ±6%, ±9% from the previous close, rounded to nearest $10.
3. That yields 6 strikes per stock (3 above, 3 below), plus optionally the rounded previous close
   itself as a 7th.
4. **Deduplicate** — for low-priced stocks, adjacent percentages round to the same $10 level.
5. Admin can add or adjust strikes before or during the trading day.

*META (prev close $680):* $620, $640, $660, $680, $700, $720, $740 → 7 unique strikes.
*AAPL (prev close $230):* −9% $210, −6% $220, −3% $220 *(dup)*, close $230, +3% $240, +6% $240
*(dup)*, +9% $250 → **5 unique strikes** after dedup.

Strikes far from the current price trade near $1.00 (deep ITM) or near $0.00 (deep OTM); the most
active trading happens near the current stock price.

### 3.4 Underlying assets (V1)

AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA.

## 4. Daily lifecycle (ET)

| Time | Event |
|---|---|
| 8:00 AM | Automation service reads previous close from oracle, calculates strikes |
| 8:30 AM | Creates contracts and order books for each strike |
| 9:00 AM | Markets visible on frontend, minting enabled |
| 9:30 AM | US market open — live trading begins |
| 4:00 PM | US market close |
| ~4:05 PM | Automation service reads oracle closing price, settles all contracts |
| 4:05 PM+ | Redemption enabled — winners claim USDC |
| Ongoing | Unredeemed tokens remain redeemable indefinitely |

## 5. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | **Daily market creation.** Automated creation of strike-level markets for all 7 stocks before market open, using the strike algorithm in §3.3 (including dedup). |
| FR-2 | **Mint / redeem.** Deposit $1.00 USDC to mint 1 Yes + 1 No token; burn a Yes+No pair to redeem $1.00 USDC. The $1.00 payout invariant must always hold. |
| FR-3 | **Order book trading.** A central limit order book per strike (Yes vs USDC) with price-time priority matching and real-time updates. |
| FR-4 | **Four trade paths.** Buy Yes, Buy No, Sell Yes, Sell No — each a first-class UI action, correctly translated to book operations per §3.2. Buy No market orders are one atomic transaction (mint pair + sell Yes at best bid), one wallet approval. Buy No limit orders mint a pair and post the Yes as a limit sell. |
| FR-5 | **Oracle settlement.** At ~4:05 PM ET, read the closing price on-chain and resolve every contract to $1 / $0 against its strike, using the at-or-above rule. |
| FR-6 | **Redemption.** Winners sign one transaction to burn tokens and receive USDC directly in the connected wallet. Unredeemed tokens stay redeemable indefinitely. |
| FR-7 | **Wallet integration & portfolio.** Connect wallet, see USDC balance, positions, fills, realized P&L (entry vs sale price), and per-contract settlement price and outcome. |
| FR-8 | **Position constraints.** A user must not hold a persistent Yes and No position in the same strike. Holding both is only a transient state inside the mint-pair operation. The frontend checks balances before presenting trade options and guides the user to exit the opposing position first. |
| FR-9 | **Market maker flow.** Mint pairs, post limit orders for Yes tokens, and see exposure, fills and P&L in a dashboard/portfolio view. |
| FR-10 | **Admin strike management.** Add or adjust strikes before or during the trading day. |

### Performance benchmarks

- Sub-second transaction finality.
- Settlement within 10 minutes of market close.
- Real-time order book updates.
- Oracle price staleness under 5 minutes.

## 6. Constraints & technology

**Chain.** Must deploy to an L1 or L2 with sub-second finality, fast enough for real-time order
book trading.

- **Solana is the recommended chain** (transaction speed, existing order book infrastructure).
  If Solana, **deployment to Solana devnet is required to pass**, with reproducible scripts to
  deploy and run the full lifecycle on devnet.
- EVM L2s (Arbitrum, Base) are acceptable alternatives, but order book latency handling must be
  justified.
- HyperLiquid is worth considering, though it may not natively support this instrument — research
  and document feasibility if explored.

**Languages & frameworks.** Smart contract: Rust + Anchor on Solana preferred; Solidity on an EVM
L2 acceptable. Frontend: TypeScript + React (Next.js recommended). Automation service:
TypeScript / Node.js.

**CLOB.** Each strike market has one order book (Yes vs USDC). Either:
- use an existing on-chain CLOB already deployed on the chosen chain (e.g. Phoenix on Solana), or
- build a minimal order book as part of the smart contract — more ambitious, demonstrates deeper
  understanding.

The CLOB is the trading venue; our program handles minting, settlement and redemption.

**Oracle.** Must provide the previous day's close (for morning strike calculation) and the current
day's close at 4:00 PM ET (for settlement), be readable on-chain during the settlement
transaction, and include a **staleness check** and a **confidence/quality check**. Choice must be
justified.

**Other constraints.**

- Secrets via environment variables; ship a `.env.example`.
- **Never use mainnet or real funds for the core submission.**
- Use standard dev tools for the chosen chain; be prepared to justify the choices.
- Avoid unnecessary third-party abstractions; justify all major dependencies.
- Include a short risks/limitations note — **no regulatory or compliance claims**.

## 7. Code quality expectations

- Unit tests for all core functions.
- Integration tests for the full lifecycle.
- Frontend tests for UI flows.
- Invariant testing (the $1.00 payout invariant above all).
- Clear documentation and reproducible deployment scripts.

## 8. Required deliverables

| Deliverable | Notes |
|---|---|
| Source code | Program(s), frontend, automation service |
| Technical documentation | Architecture, chain/oracle/CLOB rationale, risks & limitations note |
| Deployment guide | Reproducible scripts; devnet lifecycle runnable end to end |
| Test results | Unit, integration, frontend, invariant |
| Demo video | Full lifecycle: create → mint → trade → settle → redeem |
| AI usage log | **Required** — `AI_USAGE.md`, written as we go |

## 9. Traceability

Commits reference the FR they advance (e.g. `FR-5: oracle settlement with staleness check`).
Spec-kit artifacts live in `specs/`; architecture and chain decisions are logged in `DECISIONS.md`
as they are made, not reconstructed at the end.
