"use client";

/**
 * The Trade page (T065, contracts/frontend.md `/trade/[ticker]`): strike
 * ladder, order book (Yes/No perspective), countdown, trade panel, the
 * wallet's resting orders, and the payoff line for the selected strike.
 * Browsing (everything but submitting an order/cancel) works with no
 * wallet connected (FR-026 scenario 4).
 */

import { use, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSendTransaction } from "../../../lib/wallet-send";
import { earliestCloseTs, todayTradingDay } from "@/lib/markets";
import { useConfig } from "@/hooks/useConfig";
import { useMarkets, type MarketAccount } from "@/hooks/useMarkets";
import { useBook } from "@/hooks/useBook";
import { usePosition } from "@/hooks/usePosition";
import { usePrices } from "@/hooks/usePrices";
import { usePriceHistory } from "@/hooks/usePriceHistory";
import { formatStrike, formatUsd } from "@/lib/format";
import { useProgram } from "@/hooks/useProgram";
import { cancelOrder, fetchUsdcMint, mapSendError, sendTx, type BuildCtx } from "@/lib/tx";
import { BookView } from "@/components/BookView";
import { Countdown } from "@/components/Countdown";
import { OrderList } from "@/components/OrderList";
import { PayoffLine } from "@/components/PayoffLine";
import { StrikeList } from "@/components/StrikeList";
import { TradePanel } from "@/components/TradePanel";
import type { BookLevel, Perspective } from "@/lib/book-perspective";
import type { Order, Ticker } from "@meridian/sdk";
import { Skeleton } from "@/components/ui/Skeleton";
import { InlineError } from "@/components/ui/InlineError";

// The charting library is browser-only (canvas), so it's loaded with
// `ssr: false` -- the production build should carry no top-level
// `window` reference from it.
const PriceChart = dynamic(() => import("@/components/PriceChart").then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[220px] w-full" />,
});

/** `Order[]` (book.ts, carries `owner`/`id`/`seq`) to `BookLevel[]` (`price`/`qty`) for `BookView`. */
function toBookLevels(orders: Order[]): BookLevel[] {
  return orders.map((order) => ({ price: order.price, qty: order.remaining }));
}

export default function TradePage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker: rawTicker } = use(params);
  const ticker = rawTicker.toUpperCase();
  const searchParams = useSearchParams();
  // Preselects a strike linked from the Markets page (`?strike=<micro-USD>`);
  // falls back to the usual default (the ladder's middle strike) when absent
  // or when it doesn't match any of today's strikes for this ticker.
  const strikeParam = searchParams.get("strike");

  const program = useProgram();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const sendTransaction = useSendTransaction();

  const config = useConfig();
  const day = todayTradingDay();
  const { markets, loading, error } = useMarkets(day);
  const prices = usePrices();
  const lastPrice = prices[ticker]?.priceMicro;

  const tickerMarkets = useMemo(
    () => markets.filter((m) => m.ticker === ticker).sort((a, b) => Number(a.strike - b.strike)),
    [markets, ticker],
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [perspective, setPerspective] = useState<Perspective>("yes");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const selected: MarketAccount | null =
    tickerMarkets.find((m) => m.pubkey.toBase58() === selectedKey) ??
    (strikeParam !== null ? tickerMarkets.find((m) => m.strike.toString() === strikeParam) : undefined) ??
    // Default to the middle of the ladder (the rounded previous close), which is
    // where quotes cluster, rather than the lowest strike.
    tickerMarkets[Math.floor(tickerMarkets.length / 2)] ??
    null;

  const book = useBook(selected?.pubkey);
  const position = usePosition(selected?.pubkey, publicKey ?? undefined);
  const { points: priceHistory, seeding: priceHistorySeeding } = usePriceHistory(ticker as Ticker);

  // Falls back to the selected market's own close time when today has no
  // open market left (e.g. every strike already settled): the header chip
  // should still show "Settled at $X" for the selected strike rather than
  // disappearing just because `earliestCloseTs` only looks at open markets.
  const closeTs = earliestCloseTs(
    tickerMarkets,
    (m) => m.state === "open",
    (m) => m.closeTs,
  ) ?? (selected !== null ? Number(selected.closeTs) : undefined);

  async function handleCancel(order: Order) {
    if (publicKey === null || publicKey === undefined || selected === null) {
      return;
    }
    setCancelling(true);
    setCancelError(null);
    try {
      const usdcMint = await fetchUsdcMint(program);
      const ctx: BuildCtx = { program, user: publicKey, market: selected.pubkey, usdcMint };
      const ix = await cancelOrder(ctx, { orderId: order.id });
      await sendTx(connection, sendTransaction, [ix], publicKey);
    } catch (e) {
      setCancelError(mapSendError(e));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold">{ticker}</h1>
          {lastPrice !== undefined ? <span className="num text-lg font-normal text-text-muted">{formatUsd(lastPrice)}</span> : null}
          {selected !== null ? (
            <span className="num rounded-full border border-border bg-surface-raised px-3 py-1 text-sm text-text-muted">
              Price to beat {formatStrike(selected.strike)}
            </span>
          ) : null}
        </div>
        {closeTs !== undefined ? (
          <Countdown
            closeTs={closeTs}
            settled={selected?.state === "settled"}
            settlementPriceMicro={selected?.settlementPrice}
          />
        ) : null}
      </div>
      <p className="mt-1 text-sm text-text-muted">Closes 4:00 PM ET</p>

      {error ? (
        <div className="mt-6">
          <InlineError>Could not load contracts. Retrying…</InlineError>
        </div>
      ) : loading ? (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="font-semibold">Price history</h2>
              <div className="mt-2">
                <PriceChart
                  ticker={ticker}
                  points={priceHistory}
                  strikeMicro={selected?.strike}
                  loading={priceHistorySeeding}
                />
              </div>
            </div>

            <div>
              <h2 className="font-semibold">Strikes</h2>
              <div className="mt-2">
                <StrikeList
                  markets={tickerMarkets}
                  selected={selected?.pubkey ?? null}
                  onSelect={(m) => setSelectedKey(m.pubkey.toBase58())}
                  lastPriceMicro={lastPrice}
                />
              </div>

              {selected !== null ? (
                <div className="mt-4">
                  <PayoffLine ticker={ticker} strike={selected.strike} cost={book.asks[0]?.price ?? 0n} />
                </div>
              ) : null}
            </div>
          </div>

          {selected !== null ? (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="font-semibold">Trade</h2>
                <div className="mt-2">
                  <TradePanel market={selected} config={config} />
                </div>
              </div>

              <div>
                <h2 className="font-semibold">Order book</h2>
                <div className="mt-2">
                  <BookView
                    bids={toBookLevels(book.bids)}
                    asks={toBookLevels(book.asks)}
                    perspective={perspective}
                    onToggle={setPerspective}
                  />
                </div>
              </div>

              <div>
                <h2 className="font-semibold">Your open orders</h2>
                <div className="mt-2">
                  <OrderList orders={position.restingOrders} askIds={new Set(book.asks.map((o) => o.id.toString()))} onCancel={handleCancel} cancelling={cancelling} />
                  {cancelError !== null ? <p className="mt-2 text-sm text-no">{cancelError}</p> : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
