import Link from "next/link";
import type { Book, Ticker } from "@meridian/sdk";
import { countdownLabel, formatPrice, formatStrike, formatUsd, impliedProbability, oppositePrice } from "@/lib/format";
import { countOpen, isCountdownUrgent, nearestStrikes, tickerLifecycle } from "@/lib/markets";
import { representativeYesPrice } from "@/lib/book-quote";
import type { MarketAccount } from "@/hooks/useMarkets";
import { TickerMark } from "./TickerMark";

export type TickerCardProps = {
  ticker: Ticker;
  /** Last observed price, micro-USD; absent until the first price fetch resolves. */
  priceMicro?: bigint;
  /** All of today's markets for this ticker, any state, unsorted. */
  markets: MarketAccount[];
  /** Books for (at least) this ticker's markets, keyed by market base58 address. */
  books: Map<string, Book | null>;
  /** Current time, Unix seconds; passed down so every card on the page ticks from one shared clock. */
  now: number;
};

/** One ticker's summary card on the Markets page: live price, close countdown, and its nearest strikes. */
export function TickerCard({ ticker, priceMicro, markets, books, now }: TickerCardProps) {
  const lifecycle = tickerLifecycle(markets, now);
  const sorted = [...markets].sort((a, b) => (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));
  const strikes = nearestStrikes(sorted, priceMicro, 3);
  const settledMarket = markets.find((m) => m.state === "settled");
  const openCloseTs = markets
    .filter((m) => m.state === "open")
    .reduce<bigint | undefined>((min, m) => (min === undefined || m.closeTs < min ? m.closeTs : min), undefined);
  const closeTs = openCloseTs !== undefined ? Number(openCloseTs) : undefined;
  const countdown = closeTs !== undefined ? countdownLabel(now, closeTs) : null;
  const urgent = closeTs !== undefined && isCountdownUrgent(now, closeTs);
  const openCount = countOpen(markets, (m) => m.state === "open");
  const countLabel = openCount > 0 ? `${openCount} open` : `${markets.length} settled`;

  return (
    <div
      className="rounded-lg border border-border bg-surface p-4 transition hover:border-indigo/60"
      data-testid={`ticker-card-${ticker}`}
    >
      <Link href={`/trade/${ticker}`} className="block focus-visible:outline-none">
        <div className="flex items-baseline justify-between">
          <span className="flex items-center gap-2">
            <TickerMark ticker={ticker} size={28} />
            <span className="text-lg font-semibold">{ticker}</span>
          </span>
          <span className="num text-lg">{priceMicro !== undefined ? formatUsd(priceMicro) : "—"}</span>
        </div>

        <div className="mt-1 flex items-center justify-between text-sm text-text-muted">
          <span>{countLabel}</span>
          {lifecycle === "open" && countdown !== null ? (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                urgent ? "bg-warning/20 text-warning" : "bg-surface-raised text-text-muted"
              }`}
            >
              {countdown}
            </span>
          ) : lifecycle === "pending" ? (
            <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-text-muted">
              Closed, settling…
            </span>
          ) : null}
        </div>

        {lifecycle === "settled" && settledMarket !== undefined ? (
          <p className="num mt-2 text-sm text-text-muted">Settled at {formatUsd(settledMarket.settlementPrice)}</p>
        ) : null}
      </Link>

      <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
        {strikes.length === 0 ? (
          <p className="text-sm text-text-muted">No contracts yet today.</p>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span>Strike</span>
              <span>Yes</span>
              <span>No</span>
            </div>
            {strikes.map((market) => {
              const key = market.pubkey.toBase58();
              const href = `/trade/${ticker}?strike=${market.strike.toString()}`;
              if (market.state === "settled") {
                const won = market.outcome === "yes" ? "Yes" : market.outcome === "no" ? "No" : null;
                return (
                  <Link key={key} href={href} className="flex items-center justify-between text-sm hover:text-text">
                    <span className="num text-text-muted" aria-label={`Strike ${formatStrike(market.strike)}`}>
                      {formatStrike(market.strike)}
                    </span>
                    {won !== null ? (
                      <span className={`font-medium ${won === "Yes" ? "text-yes" : "text-no"}`}>{won} won</span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </Link>
                );
              }
              const yesPrice = representativeYesPrice(books.get(key));
              return (
                <Link key={key} href={href} className="flex items-center justify-between text-sm hover:text-text">
                  <span className="num text-text-muted" aria-label={`Strike ${formatStrike(market.strike)}`}>
                    {formatStrike(market.strike)}
                  </span>
                  <span
                    className="num"
                    aria-label={`Yes ${yesPrice !== undefined ? formatPrice(yesPrice) : "unavailable"}`}
                  >
                    {yesPrice !== undefined ? `${formatPrice(yesPrice)} · ${impliedProbability(yesPrice)}` : "—"}
                  </span>
                  <span
                    className="num text-text-muted"
                    aria-label={`No ${yesPrice !== undefined ? formatPrice(oppositePrice(yesPrice)) : "unavailable"}`}
                  >
                    {yesPrice !== undefined ? formatPrice(oppositePrice(yesPrice)) : "—"}
                  </span>
                </Link>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
