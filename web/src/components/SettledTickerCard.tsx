import Link from "next/link";
import type { Ticker } from "@meridian/sdk";
import { formatStrike, formatUsd } from "@/lib/format";
import { nearestStrikes } from "@/lib/markets";
import type { MarketAccount } from "@/hooks/useMarkets";

export type SettledTickerCardProps = {
  ticker: Ticker;
  /** This ticker's today's markets; every one of them has settled. */
  markets: MarketAccount[];
};

/**
 * The Markets page's compact row for a ticker whose markets have all
 * settled today: ticker, close price, and each shown strike's outcome on
 * one line, grouped under the "Settled today" heading below the open
 * cards.
 */
export function SettledTickerCard({ ticker, markets }: SettledTickerCardProps) {
  const sorted = [...markets].sort((a, b) => (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));
  const strikes = nearestStrikes(sorted, undefined, 3);
  const hidden = sorted.length - strikes.length;
  const closePrice = markets.find((m) => m.settlementPrice !== 0n)?.settlementPrice;

  return (
    <Link
      href={`/trade/${ticker}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm transition hover:border-indigo/60"
      data-testid={`ticker-card-${ticker}-settled`}
    >
      <span className="flex items-center gap-2">
        <span className="font-semibold">{ticker}</span>
        <span className="num text-text-muted">{closePrice !== undefined ? formatUsd(closePrice) : "—"}</span>
      </span>
      <span className="flex items-center gap-3">
        {strikes.map((market) => {
          const won = market.outcome === "yes" ? "Yes" : market.outcome === "no" ? "No" : null;
          return (
            <span key={market.pubkey.toBase58()} className="num flex items-center gap-1">
              <span className="text-text-muted">{formatStrike(market.strike)}</span>
              {won !== null ? (
                <span className={`font-medium ${won === "Yes" ? "text-yes" : "text-no"}`}>{won} won</span>
              ) : (
                <span className="text-text-muted">—</span>
              )}
            </span>
          );
        })}
        {hidden > 0 ? <span className="text-text-muted">+{hidden} more</span> : null}
      </span>
    </Link>
  );
}
