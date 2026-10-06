# Spike: Phoenix on devnet — integrate, or build our own order book?

**Date:** 2026-10-05
**Question:** Can Meridian use Phoenix (the existing on-chain CLOB on Solana) as its trading venue
on devnet, or should the order book be built into our own program?
**Verdict:** **Build a minimal in-program CLOB.** Phoenix is genuinely available on devnet, but two
hard constraints make it unusable for Meridian's specific shape.

---

## Method

All findings are from direct Solana RPC queries against `api.devnet.solana.com` and
`api.mainnet-beta.solana.com`, plus the Phoenix documentation. No local Solana toolchain was
required. Phoenix v1 program ID: `PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY`.

## Finding 1 — Phoenix IS deployed and live on devnet

This corrected the assumption the spike was created to test.

| Network | Executable | Owner | Program accounts |
|---|---|---|---|
| mainnet-beta | yes | BPFLoaderUpgradeable | 114,385 |
| devnet | yes | BPFLoaderUpgradeable | 1,225 |

Devnet carries ~700 market-sized accounts (84,944 / 150,480 / 175,840 / 232,544 bytes) and 474
seat accounts. Phoenix on devnet is real and in use, not a stub. **Integration was therefore a
live option, not a dead end** — which is why the remaining two constraints are the deciding
factors rather than availability.

## Finding 2 — Account rent exceeds what the devnet faucet can supply (decisive)

Phoenix market accounts are large, and Meridian needs a **fresh set every trading day** (7 tickers
× 5–7 deduplicated strikes ≈ 45 markets). Measured via `getMinimumBalanceForRentExemption`:

| Phoenix market size | Rent-exempt | × 45 markets/day |
|---|---|---|
| 84,944 B (smallest observed) | 0.4322 SOL | **19.45 SOL/day** |
| 150,480 B | 0.7651 SOL | 34.43 SOL/day |
| 232,544 B (most common large) | 1.1820 SOL | **53.19 SOL/day** |

Against that, the devnet faucet:

```
requestAirdrop 10 SOL -> "Internal error" (above per-request cap)
requestAirdrop  2 SOL -> "You've either reached your airdrop limit today
                          or the airdrop faucet has run dry."
```

The faucet caps a request at ~2 SOL and rate-limits per day. Meridian would need roughly **10–25×
the daily faucet ceiling, every day**, purely in rent, before any trading happens. The brief
requires a reproducible devnet lifecycle *and* forbids mainnet, so there is no escape route: a
reviewer could not re-run the demo.

## Finding 3 — Phoenix seats are a maker-side permission gate

Phoenix requires an approved **Seat** account to place resting (limit) orders. Takers executing
swaps do not need one. The market authority — initially the market creator — controls approval via
`RequestSeat`, `RequestSeatAuthorized` and `ChangeSeatStatus`.

Confirmed empirically by decoding the 128-byte seat accounts on devnet
(`discriminant(8) | market(32) | trader(32) | approval_status(8)`):

```
approval_status=0 (NotApproved):  15
approval_status=1 (Approved):    457
approval_status=2 (Retired):       2
```

The non-trivial NotApproved count confirms approval is a real gate, not a formality.

Why this bites Meridian specifically: seats are **per trader, per market**. We would create ~45
markets a day, so a trader active on five strikes needs five seats *per day*, each requiring a
request plus an authority-signed approval. That conflicts directly with two requirements:

- **FR-013** — a Buy No market order must complete in a single atomic operation with exactly one
  user approval. A seat handshake cannot be folded into that.
- **FR-028** — the market-maker flow is built on posting resting orders, which is precisely the
  path that requires a seat.

We would be the market authority for markets we created, so approval is *possible* — but it means
operating a permissioning service for a product whose first premise is "no KYC, non-custodial".

## The alternative, sized

Meridian's contracts are same-day expiry. That means an in-program book can be **closed at
settlement and its rent reclaimed**, which Phoenix's lifecycle does not offer. Sizing a compact
book (64-byte orders: price, size, trader, sequence, flags):

| Capacity | Account size | Rent/market | 45 markets/day |
|---|---|---|---|
| 64 orders/side | 8,328 B | 0.0430 SOL | **1.93 SOL** |
| 128 orders/side | 16,520 B | 0.0846 SOL | 3.81 SOL |
| 256 orders/side | 32,904 B | 0.1678 SOL | 7.55 SOL |

At 64–128 orders per side the daily rent is **~2–4 SOL and recycled each evening**, against
Phoenix's 19–53 SOL consumed permanently. That is the difference between a demo a reviewer can
reproduce and one they cannot.

## Trade-offs accepted

Building the book means writing and testing a matching engine — price-time priority, partial
fills, cancellation, and the atomic mint-and-sell path behind Buy No. That is real work and the
main schedule risk in the project.

Against it:

- It is the option the brief itself calls "more ambitious, demonstrates deeper understanding".
- It keeps the system self-contained and devnet-reproducible, which the deliverables require.
- It removes an external dependency, a CPI surface, and a permissioning service.
- Settlement can interact with the book directly rather than across a program boundary.

## Risks introduced, and how they are handled

- **Matching engine correctness** is now our problem. Mitigated by the constitution's ordering:
  invariant and settlement tests land before any UI work builds on them.
- **Fixed book capacity** — a full book must reject new orders rather than corrupt state. Capacity
  is a tunable constant; 128 orders/side is the starting point.
- **Compute budget** — matching is bounded work per transaction; deep crossing orders may need a
  fill limit per instruction. To be verified during implementation.

## What would change this decision

If the project moved to mainnet (it will not — the brief forbids it), Phoenix's liquidity and
battle-tested matching would outweigh building our own, and the rent arithmetic would stop
mattering. The seat constraint would remain a genuine design problem for the Buy No atomicity
requirement regardless of network.
