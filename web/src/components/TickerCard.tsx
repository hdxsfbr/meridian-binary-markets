"use client";

import { useState } from "react";
import Link from "next/link";
import type { Book, Ticker } from "@meridian/sdk";
import { countdownLabel, formatPrice, formatStrike, formatUsd, impliedProbability, oppositePrice } from "@/lib/format";
import { countOpen, groupStrikesBySettlement, isCountdownUrgent, nearestStrikes, tickerLifecycle } from "@/lib/markets";
import { representativeYesPrice } from "@/lib/book-quote";
import { isCardExpanded, setCardExpanded } from "@/lib/ticker-card-expansion";
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

/**
 * One row of a `TickerCard`'s ladder: strike, Yes/No prices (or the settled
 * outcome), and -- for the at-the-money row only -- the "Near price" badge
 * that also marks the at-the-money row in the Trade page's `StrikeList`.
 */
function StrikeRow({
  market,
  ticker,
  books,
  atm,
}: {
  market: MarketAccount;
  ticker: Ticker;
  books: Map<string, Book | null>;
  atm: boolean;
}) {
  const key = market.pubkey.toBase58();
  const href = `/trade/${ticker}?strike=${market.strike.toString()}`;
  const strikeLabel = (
    <span className="num text-text-muted" aria-label={`Strike ${formatStrike(market.strike)}`}>
      {formatStrike(market.strike)}
      {atm ? (
        <span className="ml-2 rounded-sm bg-cyan/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan">Near price</span>
      ) : null}
    </span>
  );

  if (market.state === "settled") {
    const won = market.outcome === "yes" ? "Yes" : market.outcome === "no" ? "No" : null;
    return (
      <Link href={href} className="flex items-center justify-between text-sm hover:text-text">
        {strikeLabel}
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
    <Link href={href} className="flex items-center justify-between text-sm hover:text-text">
      {strikeLabel}
      <span className="num" aria-label={`Yes ${yesPrice !== undefined ? formatPrice(yesPrice) : "unavailable"}`}>
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
}

/**
 * One ticker's summary card on the Markets page: live price, close
 * countdown, and its strike ladder. Collapsed by default to just the
 * at-the-money strike, with a "more strikes" button that expands the full
 * ladder in place; the expanded state is remembered per ticker for the rest
 * of the tab's session (`ticker-card-expansion.ts`).
 */
export function TickerCard({ ticker, priceMicro, markets, books, now }: TickerCardProps) {
  const lifecycle = tickerLifecycle(markets, now);
  // Same rule as the featured ladder: while any strike is open, the card shows only open ones.
  const groups = groupStrikesBySettlement(markets);
  const sorted = groups.allSettled ? groups.settled : groups.open;
  const hiddenSettled = groups.allSettled ? 0 : groups.settled.length;
  const atmMarket = nearestStrikes(sorted, priceMicro, 1)[0];
  const otherStrikes = atmMarket === undefined ? [] : sorted.filter((m) => !m.pubkey.equals(atmMarket.pubkey));
  const [expanded, setExpanded] = useState(() => isCardExpanded(ticker));

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    setCardExpanded(ticker, next);
  }

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
        {atmMarket === undefined ? (
          <p className="text-sm text-text-muted">No contracts yet today.</p>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span>Strike</span>
              <span>Yes</span>
              <span>No</span>
            </div>
            {(expanded
              ? [...otherStrikes, atmMarket].sort((a, b) => (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0))
              : [atmMarket]
            ).map((market) => (
              <StrikeRow
                key={market.pubkey.toBase58()}
                market={market}
                ticker={ticker}
                books={books}
                atm={market.pubkey.equals(atmMarket.pubkey)}
              />
            ))}
            {hiddenSettled > 0 ? (
              <p className="text-xs text-text-muted">
                {hiddenSettled} settled strike{hiddenSettled === 1 ? "" : "s"} today
              </p>
            ) : null}
            {otherStrikes.length > 0 ? (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={toggleExpanded}
                className="mt-1 self-start text-left text-sm font-medium text-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {expanded ? "Show fewer" : `${otherStrikes.length} more strike${otherStrikes.length === 1 ? "" : "s"}`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
