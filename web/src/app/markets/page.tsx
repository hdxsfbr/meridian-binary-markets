"use client";

import { useMemo } from "react";
import { useConfig } from "@/hooks/useConfig";
import { useMarkets } from "@/hooks/useMarkets";
import { useBooks } from "@/hooks/useBooks";
import { useNowSeconds } from "@/hooks/useNowSeconds";
import { usePrices } from "@/hooks/usePrices";
import { groupByTicker, tickerLifecycle, todayTradingDay } from "@/lib/markets";
import { representativeYesPrice } from "@/lib/book-quote";
import { TICKERS, type Ticker } from "@meridian/sdk";
import { TickerCard } from "@/components/TickerCard";
import { SettledTickerCard } from "@/components/SettledTickerCard";
import { FeaturedLadder } from "@/components/FeaturedLadder";
import { SettlementSummary } from "@/components/SettlementSummary";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineError } from "@/components/ui/InlineError";

export default function MarketsPage() {
  const day = todayTradingDay();
  const { markets, loading, error } = useMarkets(day);
  const prices = usePrices();
  const config = useConfig();
  const now = useNowSeconds();

  const byTicker = groupByTicker(markets, (m) => m.ticker);
  const enabledTickers = config?.tickers ?? TICKERS;

  const allMarketKeys = useMemo(() => markets.map((m) => m.pubkey), [markets]);
  const { books } = useBooks(allMarketKeys);

  const hasAnyMarkets = markets.length > 0;

  // The first enabled ticker with an open market that hasn't closed yet and
  // already has a quote (REVAMP_PLAN.md Wave R2: the featured ladder
  // "nearest the money for the most active ticker"); a market that's past
  // its own close but not yet settled is not eligible, so the featured slot
  // doesn't get stuck showing a ladder nobody can trade anymore. Falls back
  // to today's settlement summary once nothing is open yet.
  const featuredTicker = enabledTickers.find((ticker) => {
    const tickerMarkets = byTicker.get(ticker) ?? [];
    return tickerMarkets.some(
      (m) =>
        m.state === "open" &&
        now < Number(m.closeTs) &&
        representativeYesPrice(books.get(m.pubkey.toBase58())) !== undefined,
    );
  });
  const allSettled = hasAnyMarkets && markets.every((m) => m.state === "settled");

  // Tickers whose every market has settled move to the compact "Settled
  // today" section below the open cards instead of the full `TickerCard`.
  const settledTickers = enabledTickers.filter((ticker) => {
    const tickerMarkets = byTicker.get(ticker) ?? [];
    return tickerLifecycle(tickerMarkets, now) === "settled";
  });
  const settledTickerSet = new Set<Ticker>(settledTickers);
  const openTickers = enabledTickers.filter((ticker) => !settledTickerSet.has(ticker));

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-8">
      <h1 className="text-2xl font-semibold">Markets</h1>

      {error ? (
        <div className="mt-6">
          <InlineError>Could not load markets. Retrying…</InlineError>
        </div>
      ) : loading ? (
        <div className="mt-6 flex flex-col gap-6">
          <Skeleton className="h-48 w-full" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-full" />
            ))}
          </div>
        </div>
      ) : hasAnyMarkets ? (
        <div className="mt-6 flex flex-col gap-6">
          {featuredTicker !== undefined ? (
            <FeaturedLadder
              ticker={featuredTicker}
              markets={byTicker.get(featuredTicker) ?? []}
              books={books}
              priceMicro={prices[featuredTicker]?.priceMicro}
            />
          ) : allSettled ? (
            <SettlementSummary count={markets.length} closeTs={Number(markets[0].closeTs)} />
          ) : null}

          {openTickers.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {openTickers.map((ticker) => (
                <TickerCard
                  key={ticker}
                  ticker={ticker}
                  priceMicro={prices[ticker]?.priceMicro}
                  markets={byTicker.get(ticker) ?? []}
                  books={books}
                  now={now}
                />
              ))}
            </div>
          ) : null}

          {settledTickers.length > 0 ? (
            <div>
              <h2 className="text-sm font-medium text-text-muted">Settled today</h2>
              <div className="mt-2 flex flex-col gap-2">
                {settledTickers.map((ticker) => (
                  <SettledTickerCard key={ticker} ticker={ticker} markets={byTicker.get(ticker) ?? []} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-6">
          <EmptyState>No contracts yet today. Markets open each trading morning.</EmptyState>
        </div>
      )}
    </div>
  );
}
