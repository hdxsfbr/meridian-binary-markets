---
title: Trading
order: 3
---

# Trading

## Market or limit

Every trade is one of two kinds:

- **Market** — a market order trades against the best available quotes in price order, up to
  eight quotes in one go. Anything that can't trade right now is left out — for Buy No, the
  untouched part is undone in the same transaction, so you never end up holding extra Yes. "You
  pay" is an estimate from the current book.
- **Limit** — a limit order waits at your price until it trades or you cancel it. A Buy No limit
  that would trade immediately runs as a market order instead.

## Four actions, one price

Every strike has one **Chance** column, priced **to buy Yes**. The four trade buttons all work
off that same price:

- **Buy Yes** — takes the best Yes offers.
- **Sell Yes** — takes the best Yes bids.
- **Buy No** — pays $1.00 up front per contract and gets back the Yes it sells into the best
  bids, so your net cost is $1.00 minus that bid.
- **Sell No** — buys Yes from the best offers to pair with your No and redeems the pair, so you
  receive $1.00 minus that offer.

You never need to think about this translation yourself — pick the button for what you want, and
the app handles it.

## "You pay" and "Reserved"

Review previews such as "You pay $X," "You receive $X," "You win $Y if right," or "Reserves $X
until it trades." For a limit order that doesn't trade immediately:

- Buy Yes limits reserve USDC.
- Sell Yes limits reserve your Yes tokens.
- Buy No limits commit $1.00 per contract and reserve the Yes tokens that were created.
- Sell No limits reserve USDC.

When an order trades, what you reserved is exchanged, not refunded; cancelling returns what has
not traded. Portfolio lists this open-order collateral under **Reserved**.

## One position at a time, per side

You can hold Yes or No on a strike, not both outright. Holding No blocks Buy Yes until you sell
the No, and the other way round — the panel says "Close your No position first" with the Sell
button right below. Complete pairs you minted never block anything. You also can't trade against
your own open quote — if your own order is sitting at a price that would match your new one, the
app stops you and asks you to cancel it first.

## Open quotes

The **Open quotes** list on Portfolio shows every limit order you have waiting: which side, the
price, and how much is **Reserved**. Cancel any of them at any time to get back what hasn't
traded.
