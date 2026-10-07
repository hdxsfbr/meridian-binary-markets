"use client";

/**
 * The Trade page (T065, contracts/frontend.md `/trade/[ticker]`): strike
 * ladder, order book (Yes/No perspective), countdown, trade panel, the
 * wallet's resting orders, and the payoff line for the selected strike.
 * Browsing (everything but submitting an order/cancel) works with no
 * wallet connected (FR-026 scenario 4).
 */

import { use, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSendTransaction } from "../../../lib/wallet-send";
import { earliestCloseTs, todayTradingDay } from "@/lib/markets";
import { useConfig } from "@/hooks/useConfig";
import { useMarkets, type MarketAccount } from "@/hooks/useMarkets";
import { useBook } from "@/hooks/useBook";
import { usePosition } from "@/hooks/usePosition";
import { useProgram } from "@/hooks/useProgram";
import { cancelOrder, fetchUsdcMint, mapSendError, sendTx, type BuildCtx } from "@/lib/tx";
import { BookView } from "@/components/BookView";
import { Countdown } from "@/components/Countdown";
import { OrderList } from "@/components/OrderList";
import { PayoffLine } from "@/components/PayoffLine";
import { StrikeList } from "@/components/StrikeList";
import { TradePanel } from "@/components/TradePanel";
import type { BookLevel, Perspective } from "@/lib/book-perspective";
import type { Order } from "@meridian/sdk";

/** `Order[]` (book.ts, carries `owner`/`id`/`seq`) to `BookLevel[]` (`price`/`qty`) for `BookView`. */
function toBookLevels(orders: Order[]): BookLevel[] {
  return orders.map((order) => ({ price: order.price, qty: order.remaining }));
}

export default function TradePage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker: rawTicker } = use(params);
  const ticker = rawTicker.toUpperCase();

  const program = useProgram();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const sendTransaction = useSendTransaction();

  const config = useConfig();
  const day = todayTradingDay();
  const { markets, loading, error } = useMarkets(day);

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
    // Default to the middle of the ladder (the rounded previous close), which is
    // where quotes cluster, rather than the lowest strike.
    tickerMarkets[Math.floor(tickerMarkets.length / 2)] ??
    null;

  const book = useBook(selected?.pubkey);
  const position = usePosition(selected?.pubkey, publicKey ?? undefined);

  const closeTs = earliestCloseTs(
    tickerMarkets,
    (m) => m.state === "open",
    (m) => m.closeTs,
  );

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
    <div className="px-6 py-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{ticker}</h1>
        {closeTs !== undefined ? <Countdown closeTs={closeTs} /> : null}
      </div>

      {error ? (
        <p className="mt-6 text-black/70">Could not load contracts. Retrying…</p>
      ) : loading ? (
        <p className="mt-6 text-black/70">Loading contracts…</p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div>
            <h2 className="font-semibold">Strikes</h2>
            <div className="mt-2">
              <StrikeList
                markets={tickerMarkets}
                selected={selected?.pubkey ?? null}
                onSelect={(m) => setSelectedKey(m.pubkey.toBase58())}
              />
            </div>

            {selected !== null ? (
              <div className="mt-6">
                <PayoffLine ticker={ticker} strike={selected.strike} cost={book.asks[0]?.price ?? 0n} />
              </div>
            ) : null}
          </div>

          {selected !== null ? (
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

              <div className="mt-6">
                <TradePanel market={selected} config={config} />
              </div>

              <div className="mt-6">
                <h2 className="font-semibold">Your open orders</h2>
                <div className="mt-2">
                  <OrderList orders={position.restingOrders} askIds={new Set(book.asks.map((o) => o.id.toString()))} onCancel={handleCancel} cancelling={cancelling} />
                  {cancelError !== null ? <p className="mt-2 text-sm text-red-700">{cancelError}</p> : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
