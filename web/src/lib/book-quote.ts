/**
 * The representative Yes price for a strike's order book: best ask, else
 * best bid, else `undefined` (no orders yet). Shared by `StrikeList` (the
 * Trade page's strike picker) and the Markets page's ticker cards /
 * featured ladder so every strike row derives its Yes/No price the same
 * way (REVAMP_PLAN.md decision 3: "best ask, labelled to buy Yes").
 */

import { bestAsk, bestBid, type Book } from "@meridian/sdk";

export type YesQuote = {
  price: bigint;
  /** True when `price` comes from a real ask (sellers offering Yes); false when it falls back to the best bid, which is not a price you can buy Yes at. */
  fromAsk: boolean;
};

/** The representative Yes quote for a strike's order book, with enough provenance to label it correctly: best ask (a real "buy Yes" price) when one exists, else best bid (not a buy price), else `undefined` with no orders yet. */
export function representativeYesQuote(book: Book | null | undefined): YesQuote | undefined {
  if (book === null || book === undefined) {
    return undefined;
  }
  const ask = bestAsk(book);
  if (ask !== undefined) {
    return { price: ask.price, fromAsk: true };
  }
  const bid = bestBid(book);
  if (bid !== undefined) {
    return { price: bid.price, fromAsk: false };
  }
  return undefined;
}

export function representativeYesPrice(book: Book | null | undefined): bigint | undefined {
  return representativeYesQuote(book)?.price;
}
