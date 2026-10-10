import Link from "next/link";
import type { Book, Ticker } from "@meridian/sdk";
import { formatPrice, formatStrike, impliedProbability, oppositePrice } from "@/lib/format";
import { groupStrikesBySettlement, nearestStrikes } from "@/lib/markets";
import { representativeYesQuote } from "@/lib/book-quote";
import type { MarketAccount } from "@/hooks/useMarkets";
import { Card } from "./ui/Card";
import { TickerMark } from "./TickerMark";

export type FeaturedLadderProps = {
  ticker: Ticker;
  /** This ticker's today's markets, any state, unsorted. */
  markets: MarketAccount[];
  books: Map<string, Book | null>;
  priceMicro?: bigint;
};

/** The Markets page's top-of-page ladder: every strike for the most active open ticker, at-the-money row highlighted. */
export function FeaturedLadder({ ticker, markets, books, priceMicro }: FeaturedLadderProps) {
  // Open strikes only while any are open; settled ones are counted below the table so a
  // decided outcome never sits between live quotes. After the close, every row is settled.
  const groups = groupStrikesBySettlement(markets);
  const sorted = groups.allSettled ? groups.settled : groups.open;
  const atmKey = priceMicro !== undefined ? nearestStrikes(sorted, priceMicro, 1)[0]?.pubkey.toBase58() : undefined;

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-sm text-text-muted">Featured</p>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <TickerMark ticker={ticker} size={28} />
            {ticker}
          </h2>
        </div>
        <Link href={`/trade/${ticker}`} className="text-sm font-medium text-cyan underline-offset-2 hover:underline">
          Trade
        </Link>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-text-muted">
            <th className="py-1 pr-4 font-normal">Strike</th>
            <th className="py-1 pr-4 font-normal">Yes</th>
            <th className="py-1 pr-4 font-normal">No</th>
            <th className="py-1 font-normal">Chance</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((market) => {
            const key = market.pubkey.toBase58();
            const atm = key === atmKey;

            if (market.state === "settled") {
              const won = market.outcome === "yes" ? "Yes" : market.outcome === "no" ? "No" : null;
              return (
                <tr key={key} className={atm ? "bg-surface-raised" : undefined}>
                  <td className="num py-1 pr-4">{formatStrike(market.strike)}</td>
                  <td colSpan={3} className="py-1">
                    {won !== null ? (
                      <span className={`font-medium ${won === "Yes" ? "text-yes" : "text-no"}`}>{won} won</span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            }

            const quote = representativeYesQuote(books.get(key));
            const yesPrice = quote?.price;
            return (
              <tr key={key} className={atm ? "bg-surface-raised" : undefined}>
                <td className="num py-1 pr-4">{formatStrike(market.strike)}</td>
                <td className="num py-1 pr-4">{yesPrice !== undefined ? formatPrice(yesPrice) : "—"}</td>
                <td className="num py-1 pr-4">{yesPrice !== undefined ? formatPrice(oppositePrice(yesPrice)) : "—"}</td>
                <td className="num py-1">
                  {yesPrice !== undefined ? (
                    <>
                      {impliedProbability(yesPrice)}
                      <span className="ml-1 text-xs text-text-muted">
                        {quote?.fromAsk === true ? "to buy Yes" : "last bid"}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
