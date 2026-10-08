---
title: How contracts work
order: 2
---

# How contracts work

## Yes and No

Every Meridian contract is a simple either/or question about a stock, for example: *"Will TSLA
close at or above $250 today?"* Trading it gives you one of two complementary tokens:

- A **Yes** token pays **$1.00** if the stock closes **at or above** the strike price, and $0.00
  otherwise.
- A **No** token pays **$1.00** if the stock closes **below** the strike price, and $0.00
  otherwise.

One Yes and one No from the same contract can be redeemed together for $1.00, but buying both
separately at current offers can cost more than $1.00.

## The tie rule

Ties go to Yes. The rule is *at or above*, not *above*. For "closes at or above $250":

| Closing price | Yes pays | No pays |
| --- | --- | --- |
| $255 | $1.00 | $0.00 |
| $250 (exactly the strike) | $1.00 | $0.00 |
| $245 | $0.00 | $1.00 |

## Price as implied chance

The best available Yes offer doubles as the market's implied chance of the stock closing at or
above the strike — if Yes offers sit around $0.60, the market is pricing that at roughly a 60%
chance. That's why the trade page labels the price column **Chance**, showing the best Yes offer
labelled **to buy Yes**, or the best Yes bid labelled **last bid** when no offer exists. Check the
preview for the action you pick for its exact trading price.

## Closing time

Every contract trades until its recorded close time, normally 4:00 PM ET for the daily stock
markets. After that, no more trading happens on that contract, and it moves toward settlement
using the recorded settlement price: an accepted oracle observation for automatic settlement, or
the operator-supplied price for an override. See
[Settlement and redemption](/docs/settlement-and-redemption) for how that works, and
[Trading](/docs/trading) for how to buy and sell before the close.
