"use client";

import { useEffect, useState } from "react";
import { formatStrike } from "@/lib/format";
import type { MarketLike, PositionRowData } from "@/lib/positions-view";

export type MakerPanelProps = {
  /** Open markets a pair can be minted in. */
  openMarkets: readonly MarketLike[];
  /** The wallet's current rows, for the exposure/fills table. */
  rows: readonly PositionRowData[];
  fillsCountByMarket: ReadonlyMap<string, number>;
  onMint: (market: MarketLike, qty: bigint) => void | Promise<void>;
  /** Trading is paused: mint is disabled, exposure/fills still show (FR-034). */
  disabled?: boolean;
  minting?: boolean;
};

/** Market-maker view: mint-pairs form, plus exposure (Yes − No) and fill counts per strike. */
export function MakerPanel({ openMarkets, rows, fillsCountByMarket, onMint, disabled, minting }: MakerPanelProps) {
  const [marketKey, setMarketKey] = useState<string>(openMarkets[0]?.pubkey.toBase58() ?? "");
  const [qty, setQty] = useState<string>("1");

  const selected = openMarkets.find((m) => m.pubkey.toBase58() === marketKey);

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
                {m.ticker} {formatStrike(m.strike)}
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

      <div>
        <h3 className="text-sm font-semibold text-black/60">Exposure and fills</h3>
        <div className="mt-2 flex flex-col gap-1">
          {rows.length === 0 ? (
            <span className="text-sm text-black/60">No resting exposure yet.</span>
          ) : (
            rows.map((row) => (
              <div key={row.marketKey} className="flex items-center justify-between text-sm">
                <span>
                  {row.ticker} {formatStrike(row.strike)}
                </span>
                <span>Exposure (Yes − No): {row.exposure.toString()}</span>
                <span>Fills: {fillsCountByMarket.get(row.marketKey) ?? 0}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
