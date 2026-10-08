"use client";

import Link from "next/link";
import { formatStrike, formatTradingDay, formatUsd } from "@/lib/format";
import type { PositionRowData } from "@/lib/positions-view";

export type PositionRowProps = {
  row: PositionRowData;
  onRedeemWinning?: () => void;
  onRedeemPair?: () => void;
  redeemingWinning?: boolean;
  redeemingPair?: boolean;
  /** True while the wallet's trade history is still syncing, so cost basis and P&L are not yet known. */
  costBasisPending?: boolean;
};

/** One market's line in the Portfolio page: open/settled badge, a single "Minted pair" line for the matched portion, any one-sided Yes/No balance, and the redeem actions each balance is eligible for. */
export function PositionRow({ row, onRedeemWinning, onRedeemPair, redeemingWinning, redeemingPair, costBasisPending }: PositionRowProps) {
  // The unmatched portion of each side; if a side is fully matched into
  // pairs but still redeemable as the winning side (settled, this side
  // won), show it anyway -- "Minted pair" and "Redeem winning" are two
  // different options over the same held tokens, not two different pools.
  const yesOnly =
    row.yes - row.pairsHeld > 0n
      ? row.yes - row.pairsHeld
      : row.canRedeemWinning && row.winningSide === "yes"
        ? row.yes
        : 0n;
  const noOnly =
    row.no - row.pairsHeld > 0n
      ? row.no - row.pairsHeld
      : row.canRedeemWinning && row.winningSide === "no"
        ? row.no
        : 0n;

  return (
    <div className="flex flex-col gap-2 rounded border border-border p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">
          {row.ticker} {formatStrike(row.strike)}
          {row.tradingDay !== undefined ? <span className="ml-2 font-normal text-text-muted">· {formatTradingDay(row.tradingDay)}</span> : null}
        </span>
        <span className="flex items-center gap-3 text-sm">
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${row.state === "settled" ? "bg-surface-raised text-text-muted" : "bg-success/15 text-success"}`}
          >
            {row.state === "settled" ? "Settled" : "Open"}
          </span>
          {row.state === "settled" ? null : (
            <Link href={`/trade/${row.ticker}`} className="underline">
              Trade
            </Link>
          )}
        </span>
      </div>

      {row.state === "settled" && row.settlementPriceMicro !== undefined && row.winningSide ? (
        <div className="text-sm">
          Settled at {formatUsd(row.settlementPriceMicro)} — {row.winningSide === "yes" ? "Yes" : "No"} wins
        </div>
      ) : null}

      {row.pairsHeld > 0n ? (
        <div className="flex items-center justify-between">
          <span>Minted pair — qty {row.pairsHeld.toString()}</span>
          {row.canRedeemPair && onRedeemPair ? (
            <button type="button" onClick={onRedeemPair} disabled={redeemingPair}>
              {redeemingPair ? "Redeeming…" : "Redeem pair"}
            </button>
          ) : null}
        </div>
      ) : null}

      {yesOnly > 0n ? (
        <div className="flex items-center justify-between">
          <span>Yes — qty {yesOnly.toString()}</span>
          {row.canRedeemWinning && row.winningSide === "yes" && onRedeemWinning ? (
            <button type="button" onClick={onRedeemWinning} disabled={redeemingWinning}>
              {redeemingWinning ? "Redeeming…" : "Redeem winning"}
            </button>
          ) : null}
        </div>
      ) : null}

      {row.restingYes > 0n ? (
        <div className="flex items-center justify-between text-sm text-text-muted">
          <span>Yes resting (order book) — qty {row.restingYes.toString()}</span>
        </div>
      ) : null}

      {noOnly > 0n ? (
        <div className="flex items-center justify-between">
          <span>No — qty {noOnly.toString()}</span>
          {row.canRedeemWinning && row.winningSide === "no" && onRedeemWinning ? (
            <button type="button" onClick={onRedeemWinning} disabled={redeemingWinning}>
              {redeemingWinning ? "Redeeming…" : "Redeem winning"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="text-sm text-text-muted">
        {costBasisPending ? "Cost basis and P&L: syncing history…" : `Cost basis ${formatUsd(row.costBasisMicro)} · Realized P&L ${formatUsd(row.realizedPnlMicro)}`}
      </div>
    </div>
  );
}
