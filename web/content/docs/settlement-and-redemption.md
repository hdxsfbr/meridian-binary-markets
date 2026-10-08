---
title: Settlement and redemption
order: 5
---

# Settlement and redemption

## Where the closing price comes from

Each contract settles using its recorded settlement price. Trading stops at the contract's
recorded close time, normally 4:00 PM ET for the daily stock markets. For automatic settlement,
the closing price must come from Pyth at the 4:00 PM ET close (a small allowance of about a
minute before the bell is permitted), be fresh, and have a tight confidence band; otherwise
settlement is refused and retried. For an override, the operator supplies the price by hand (see
below).

## If the price isn't ready yet

The settlement service retries every 30 seconds for up to 15 minutes from when it starts; if it
still cannot settle, it alerts the operator. During this window, Markets and the Trade countdown
show **Closed, settling…**, and Portfolio shows **Closed, settling** — trading has stopped, but
the outcome isn't final yet.

If automatic settlement still can't complete, the operator can settle the contract by hand, but
only starting at least one hour after the close (the exact delay is a setting; today it is one
hour). The operator supplies the closing price by hand. This path is for oracle failures only; it
does not re-check the price against Pyth, which is why it is time-locked and visible on chain as
an override.

## Redeeming

Once a contract settles, every Yes and No token on it is worth exactly $1.00 or $0.00, final. If
you're holding the winning side, Portfolio shows **Redeem winning** — press it, sign one
transaction in your wallet, and the payout lands in your USDC balance. If you're holding a
matched pair (equal Yes and No), you don't need to wait for settlement at all — **Redeem pair**
pays out $1.00 per pair any time, win or lose, since a pair is worth $1.00 regardless of outcome.

Winning tokens stay redeemable indefinitely — there's no deadline, so there's no rush to redeem
the moment a contract settles. If you're holding winners or pairs across several contracts at
once, **Redeem all** collects everything you can collect: pairs first, then winning tokens,
grouped up to three actions per wallet approval. If a later batch fails, what already went
through stays collected.
