"use client";

import { formatStrike, formatUsd } from "@/lib/format";
import type { PositionRowData } from "@/lib/positions-view";

export type PositionRowProps = {
  row: PositionRowData;
  onRedeemWinning?: () => void;
  onRedeemPair?: () => void;
  redeemingWinning?: boolean;
  redeemingPair?: boolean;
};

/** One market's line in the Portfolio page: open/settled badge, a single "Minted pair" line for the matched portion, any one-sided Yes/No balance, and the redeem actions each balance is eligible for. */
export function PositionRow({ row, onRedeemWinning, onRedeemPair, redeemingWinning, redeemingPair }: PositionRowProps) {
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
    <div className="flex flex-col gap-2 rounded border border-black/10 p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">
          {row.ticker} {formatStrike(row.strike)}
        </span>
        <span className="text-sm text-black/60">{row.state === "settled" ? "Settled" : "Open"}</span>
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
        <div className="flex items-center justify-between text-sm text-black/60">
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

      <div className="text-sm text-black/60">
        Cost basis {formatUsd(row.costBasisMicro)} · Realized P&amp;L {formatUsd(row.realizedPnlMicro)}
      </div>
    </div>
  );
}
