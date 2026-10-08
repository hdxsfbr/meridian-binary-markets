---
title: Portfolio and history
order: 6
---

# Portfolio and history

## Portfolio

Portfolio is the home base for everything you're holding:

- **USDC balance** — your spendable cash on the test network.
- **Positions** — grouped by contract, showing your Yes and No quantities, cost basis (the
  combined dollars you paid for what you still hold, using average cost), and realized profit or
  loss from anything you've already closed out.
- **Pairs** — matched Yes/No pairs you're holding, each redeemable for $1.00 at any time.
- **Open quotes** — any limit orders still waiting to trade, with the price and how much is
  Reserved.
- **Redeem winning** / **Redeem pair** / **Redeem all** — collect payouts, as covered in
  [Settlement and redemption](/docs/settlement-and-redemption).

If your trade history is still loading in the background, Portfolio shows a quiet
"Updating your trade history…" line. Your balances and holdings don't wait on this; cost basis,
realized profit or loss, and trade counts can stay incomplete until history finishes loading.

## History

History is a chronological log of everything your wallet has done: minting pairs, trades,
placing and cancelling open quotes, settlements, and redemptions, newest first and grouped by day.
Every row links out to the transaction on the Solana block explorer, so you can see exactly what
happened on chain.

For the technical details behind any of this — the account structure, the matching rules, how
settlement is computed — the project's README has the full developer documentation.
