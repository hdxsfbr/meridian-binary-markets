---
title: FAQ and limits
order: 7
---

# FAQ and limits

## Is this real money?

No. Meridian runs on **Solana Devnet**, a public test network. The SOL and USDC you use here have
no real-world value, and nothing you do on this app moves real funds. It exists to let you try
out the full trading experience safely.

## Where do I get test SOL and USDC?

- **Test SOL** (for transaction fees): [faucet.solana.com](https://faucet.solana.com) — paste your
  wallet address and request 1 SOL.
- **Test USDC** (to trade with): [faucet.circle.com](https://faucet.circle.com) — choose asset
  USDC and network **Solana Devnet**, paste your address, and send 20 USDC. You can request again
  from the same address every two hours.

See [Quick start](/docs/quick-start) for the full walkthrough.

## Why does a price sometimes say "—"?

Prices refresh every 15 seconds. If a new price hasn't arrived yet, the app keeps showing the
last good price while it retries in the background; if a price was never available, it shows
"—" instead.

## Where do prices come from?

The live stock price shown on the ticker and the trade page comes from the Pyth price oracle.
The same feed supplies the accepted oracle observation used for automatic settlement at a
contract's recorded close time, normally 4:00 PM ET for the daily stock markets — see
[Settlement and redemption](/docs/settlement-and-redemption) for the checks it has to pass and
what happens on an override.

## What does "Closed, settling" mean?

A contract stops trading the instant it reaches its recorded close time, normally 4:00 PM ET for
the daily stock markets. After that it moves toward settlement using the recorded settlement
price, and stays pending until automatic settlement or an operator override succeeds — Markets
and the Trade countdown show **Closed, settling…**, and Portfolio shows **Closed, settling**,
while that's in progress. There's no guaranteed completion time.

## Why don't I see a price at some strikes?

**Chance** shows the best Yes offer. If there's no offer, it falls back to the best Yes bid,
labelled **last bid**. If there's neither, it shows nothing — even if the contract traded
earlier. This is normal for strikes that are far from the current stock price.

## Something looks stale or stuck

Reload the page first — the public test network occasionally rate-limits requests, which can
briefly delay an update. Known trading problems get a plain-language message; some failures can
include technical details.

## Developer documentation

This site covers trading. If you want to understand how Meridian is built under the hood, the
project's README on its repository walks through the architecture and how to run it yourself.
