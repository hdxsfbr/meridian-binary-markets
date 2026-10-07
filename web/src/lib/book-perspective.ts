/**
 * Pure transform for rendering an order book from the Yes or the No
 * perspective. The book is always stored/transmitted in Yes terms (bids are
 * Yes buyers, asks are Yes sellers); viewing it "as No" means re-pricing
 * every level with `oppositePrice` and swapping which side is which, since
 * a No buyer is economically a Yes seller and vice versa.
 */

import { oppositePrice } from "./format";

export type BookLevel = { price: bigint; qty: bigint };

export type Perspective = "yes" | "no";

export type BookView = {
  bids: BookLevel[];
  asks: BookLevel[];
};

/**
 * Sorts a descending-by-price copy of bid levels (best bid first) and an
 * ascending-by-price copy of ask levels (best ask first), without mutating
 * the inputs.
 */
function sortedBids(levels: BookLevel[]): BookLevel[] {
  return [...levels].sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0));
}

function sortedAsks(levels: BookLevel[]): BookLevel[] {
  return [...levels].sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : 0));
}

/**
 * Projects a Yes-terms book into the requested perspective. In the "no"
 * perspective, Yes asks become No bids (and vice versa), each re-priced via
 * `oppositePrice`; qty is unchanged. Returned levels are sorted best-first.
 */
export function toPerspective(bids: BookLevel[], asks: BookLevel[], perspective: Perspective): BookView {
  if (perspective === "yes") {
    return { bids: sortedBids(bids), asks: sortedAsks(asks) };
  }

  const noBids = asks.map((level) => ({ price: oppositePrice(level.price), qty: level.qty }));
  const noAsks = bids.map((level) => ({ price: oppositePrice(level.price), qty: level.qty }));
  return { bids: sortedBids(noBids), asks: sortedAsks(noAsks) };
}

/** Best bid (highest price) or undefined if the side is empty. */
export function bestBid(levels: BookLevel[]): BookLevel | undefined {
  return sortedBids(levels)[0];
}

/** Best ask (lowest price) or undefined if the side is empty. */
export function bestAsk(levels: BookLevel[]): BookLevel | undefined {
  return sortedAsks(levels)[0];
}

/** Spread between best ask and best bid, or undefined if either side is empty. */
export function spread(bids: BookLevel[], asks: BookLevel[]): bigint | undefined {
  const bid = bestBid(bids);
  const ask = bestAsk(asks);
  if (bid === undefined || ask === undefined) {
    return undefined;
  }
  return ask.price - bid.price;
}
