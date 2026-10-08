---
title: Market making
order: 4
---

# Market making

Buying and selling cover most trading, but you can also provide both sides of the market
yourself — quoting a price to buy and a price to sell at the same time, and earning the gap
between them when both trade.

## Minting pairs

Before you can offer to sell Yes (or No) without already holding it, you mint it. Minting a pair
costs exactly $1.00 in USDC and gives you one Yes token and one No token — together always worth
$1.00, whatever happens at the close. From there, you can sell either side, hold both, or sell one
and keep the other as your own position.

## A worked example

Say TSLA $250 is trading with Yes around $0.60 (implying roughly a 60% chance of closing at or
above $250). You think that's about right, and you'd rather earn the gap between a buy and a sell
than bet a direction.

1. **Mint 10 pairs.** You pay $10.00 USDC and now hold 10 Yes and 10 No tokens.
2. **Quote both sides.** Post an offer to sell 10 Yes at $0.62 (slightly above the $0.60 chance),
   and an offer to buy 10 Yes at $0.58 (slightly below it). The sell quote uses the 10 Yes tokens
   you already hold; the buy quote needs an additional $5.80 USDC reserved on top of the $10.00
   you spent minting. Buying Yes at $0.58 is the same thing as offering to sell No at $0.42 — on
   the Yes order book, "Buy No at $0.42" is simply entered as "sell Yes at $0.58."
3. **Wait for both to trade.** If another trader buys your 10 Yes at $0.62, and later another
   trader sells you 10 Yes at $0.58, you've collected $0.04 per contract — $0.40 total — while
   ending up back where you started (holding 10 complete pairs again, redeemable for $10.00, plus the $0.40 gap in cash).
4. **Either side can trade first, or not at all.** Quotes are independent open orders. You might
   get only one side matched today, or neither. Cancelling an open quote returns whatever it was
   backed by — USDC for a buy, tokens for a sell — right away.

## Net Yes and Pairs

Portfolio's quoting panel tracks your running position as you mint and quote:

- **Net Yes** — your available Yes quantity minus your available No quantity, excluding Yes
  tokens reserved in open sell quotes. Zero means your pairs are balanced; a positive or negative
  number means you're leaning one direction.
- **Pairs** — the smaller of your available Yes and No quantities, each pair redeemable for
  $1.00 regardless of the outcome.
- **Open buys** and **Open sells** — the remaining contract quantities in your open Yes buy and
  sell orders.

## Limits and cancelling

Each side has 16 order slots shared by everyone in this demo; one order uses one slot whatever
its size. If you're quoting several prices on one side, space them out rather than stacking many
small orders. You can cancel one open quote at a time, or use "Cancel all on this market," which
cancels your open quotes on that strike in batches of up to six per approval — each batch's
reserve comes back as it confirms.
