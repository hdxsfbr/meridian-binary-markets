"use client";

import { useConfig } from "@/hooks/useConfig";
import { useMarkets } from "@/hooks/useMarkets";
import { usePrices } from "@/hooks/usePrices";
import { countOpen, earliestCloseTs, groupByTicker, todayTradingDay } from "@/lib/markets";
import { TICKERS } from "@meridian/sdk";
import { TickerCard } from "@/components/TickerCard";

export default function MarketsPage() {
  const day = todayTradingDay();
  const { markets, loading, error } = useMarkets(day);
  const prices = usePrices();
  const config = useConfig();

  const byTicker = groupByTicker(markets, (m) => m.ticker);
  const enabledTickers = config?.tickers ?? TICKERS;

  const hasAnyMarkets = markets.length > 0;

  return (
    <div className="px-6 py-8">
      <h1 className="text-2xl font-semibold">Markets</h1>

      {error ? (
        <p className="mt-6 text-black/70">Could not load markets. Retrying…</p>
      ) : loading ? (
        <p className="mt-6 text-black/70">Loading markets…</p>
      ) : hasAnyMarkets ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {enabledTickers.map((ticker) => {
            const tickerMarkets = byTicker.get(ticker) ?? [];
            const openCount = countOpen(tickerMarkets, (m) => m.state === "open");
            const closeTs = earliestCloseTs(
              tickerMarkets,
              (m) => m.state === "open",
              (m) => m.closeTs,
            );
            return (
              <TickerCard
                key={ticker}
                ticker={ticker}
                priceMicro={prices[ticker]?.priceMicro}
                openCount={openCount}
                closeTs={closeTs}
              />
            );
          })}
        </div>
      ) : (
        <p className="mt-6 text-black/70">No contracts yet today. Markets open each trading morning.</p>
      )}
    </div>
  );
}
