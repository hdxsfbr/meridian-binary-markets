"use client";

import { useEffect, useMemo, useState } from "react";
import type { Book } from "@meridian/sdk";
import { formatStrike, formatUsd, marketOptionLabel } from "@/lib/format";
import type { MyOrderRow, RestingTotals } from "@/lib/maker-view";
import type { MarketLike, PositionRowData } from "@/lib/positions-view";
import { MakerQuoteForm, type QuoteSide } from "./MakerQuoteForm";
import { MyOrders } from "./MyOrders";

export type MakerPanelProps = {
  /** Open markets a pair can be minted in (any trading day still open). */
  openMarkets: readonly MarketLike[];
  /** Today's open markets a quote can be posted to (contracts/frontend.md: quoting picks from today's ladder). */
  quoteMarkets: readonly MarketLike[];
  /** The wallet's current rows, for the exposure/fills table. */
  rows: readonly PositionRowData[];
  fillsCountByMarket: ReadonlyMap<string, number>;
  /** Resting bid/ask quantity and escrow per market, from `useMyOrders`. */
  restingTotalsByMarket: ReadonlyMap<string, RestingTotals>;
  /** Realized P&L across every market, from `usePositions`. */
  realizedPnlMicro: bigint;
  onMint: (market: MarketLike, qty: bigint) => void | Promise<void>;
  /** Trading is paused: mint/quote are disabled, exposure/fills/orders still show (FR-034). */
  disabled?: boolean;
  minting?: boolean;
  /** The wallet's available USDC, micro-USDC -- a bid quote's escrow draws on this. */
  availableUsdcMicro: bigint;
  onSubmitQuote: (market: MarketLike, side: QuoteSide, priceMicro: bigint, qty: bigint) => Promise<void>;
  myOrders: readonly MyOrderRow[];
  onCancelOrder: (row: MyOrderRow) => void | Promise<void>;
  onCancelAllOnMarket: (marketKey: string) => void | Promise<void>;
  cancelling?: string | null;
  /** `useMyOrders`' `error`: at least one market's Book failed to load, so `myOrders`/`restingTotalsByMarket` may be stale. */
  myOrdersError?: boolean;
  /** Decoded `Book` per market (base58), from `useMyOrders`, for the quote form's crossing check (item 14). */
  booksByMarket: ReadonlyMap<string, Book | null>;
};

/** Market-maker view: mint-pairs form, quoting, resting orders, and exposure/fills/P&L per strike. */
export function MakerPanel({
  openMarkets,
  quoteMarkets,
  rows,
  fillsCountByMarket,
  restingTotalsByMarket,
  realizedPnlMicro,
  onMint,
  disabled,
  minting,
  availableUsdcMicro,
  onSubmitQuote,
  myOrders,
  onCancelOrder,
  onCancelAllOnMarket,
  cancelling,
  myOrdersError,
  booksByMarket,
}: MakerPanelProps) {
  const [marketKey, setMarketKey] = useState<string>(openMarkets[0]?.pubkey.toBase58() ?? "");
  const [qty, setQty] = useState<string>("1");

  const selected = openMarkets.find((m) => m.pubkey.toBase58() === marketKey);

  // Item 18: the summary must show every market with inventory OR resting
  // orders -- a market can have resting orders (e.g. an ask backed by Yes
  // minted earlier and since fully quoted out) with no `rows` entry, or
  // inventory with no resting order; neither side alone is the full set.
  const summaryRows = useMemo(() => {
    const byMarket = new Map<
      string,
      { marketKey: string; ticker: string; strike: bigint; exposure: bigint; pairsHeld: bigint; settled: boolean }
    >();
    for (const row of rows) {
      byMarket.set(row.marketKey, {
        marketKey: row.marketKey,
        ticker: row.ticker,
        strike: row.strike,
        exposure: row.exposure,
        pairsHeld: row.pairsHeld,
        settled: row.state === "settled",
      });
    }
    for (const order of myOrders) {
      if (!byMarket.has(order.marketKey)) {
        byMarket.set(order.marketKey, {
          marketKey: order.marketKey,
          ticker: order.ticker,
          strike: order.strike,
          exposure: 0n,
          pairsHeld: 0n,
          settled: false,
        });
      }
    }
    return Array.from(byMarket.values());
  }, [rows, myOrders]);

  // Auto-select the first market once `openMarkets` loads (or changes such
  // that the current selection no longer exists in it), e.g. on first
  // mount before any markets have arrived, or after the selected market
  // settles and drops out of the open list (item 16).
  useEffect(() => {
    if (openMarkets.length === 0) {
      return;
    }
    if (marketKey === "" || !openMarkets.some((m) => m.pubkey.toBase58() === marketKey)) {
      setMarketKey(openMarkets[0].pubkey.toBase58());
    }
  }, [openMarkets, marketKey]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) {
      return;
    }
    const parsed = BigInt(qty || "0");
    if (parsed <= 0n) {
      return;
    }
    void onMint(selected, parsed);
  }

  return (
    <div className="flex flex-col gap-4 rounded border border-black/10 p-4">
      <h2 className="text-lg font-semibold">Market maker</h2>

      <form onSubmit={handleSubmit} className="flex items-end gap-3">
        <label className="flex flex-col text-sm">
          Market
          <select
            value={marketKey}
            onChange={(e) => setMarketKey(e.target.value)}
            disabled={disabled || openMarkets.length === 0}
          >
            {openMarkets.map((m) => (
              <option key={m.pubkey.toBase58()} value={m.pubkey.toBase58()}>
                {marketOptionLabel(m, openMarkets)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Pairs to mint
          <input
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            disabled={disabled}
          />
        </label>
        <button type="submit" disabled={disabled || minting || !selected}>
          {disabled ? "Trading is paused" : minting ? "Minting…" : "Mint pair"}
        </button>
      </form>

      <span className="text-sm text-black/60">
        Realized P&amp;L across every market: <span className="font-semibold">{formatUsd(realizedPnlMicro)}</span>
      </span>

      <div>
        <h3 className="text-sm font-semibold text-black/60">Exposure, fills and resting totals</h3>
        <div className="mt-2 flex flex-col gap-1">
          {summaryRows.length === 0 ? (
            <span className="text-sm text-black/60">No resting exposure yet.</span>
          ) : (
            summaryRows.map((row) => {
              const totals = restingTotalsByMarket.get(row.marketKey);
              return (
                <div key={row.marketKey} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    {row.ticker} {formatStrike(row.strike)}
                    {row.settled ? <span className="ml-2 text-xs text-black/60"> · Settled</span> : null}
                  </span>
                  <span>Exposure (Yes − No): {row.exposure.toString()}</span>
                  <span>Pairs held: {row.pairsHeld.toString()}</span>
                  <span>Fills: {fillsCountByMarket.get(row.marketKey) ?? 0}</span>
                  <span>
                    Resting: {totals?.bidQty.toString() ?? "0"} bid / {totals?.askQty.toString() ?? "0"} ask
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <MakerQuoteForm
        openMarkets={quoteMarkets}
        availableYesByMarket={new Map(rows.map((row) => [row.marketKey, row.yes]))}
        availableUsdcMicro={availableUsdcMicro}
        booksByMarket={booksByMarket}
        onSubmitQuote={onSubmitQuote}
        disabled={disabled}
      />

      <MyOrders
        rows={myOrders}
        onCancel={onCancelOrder}
        onCancelAllOnMarket={onCancelAllOnMarket}
        cancelling={cancelling}
        error={myOrdersError}
      />
    </div>
  );
}
