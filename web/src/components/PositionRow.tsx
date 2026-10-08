"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatStrike, formatTradingDay, formatUsd } from "@/lib/format";
import type { PositionRowData } from "@/lib/positions-view";
import { Card } from "@/components/ui/Card";

export type PositionRowProps = {
  row: PositionRowData;
  onRedeemWinning?: () => void;
  onRedeemPair?: () => void;
  /** This row's own winning redemption is the one in flight -- only affects the button's label. */
  redeemingWinning?: boolean;
  /** This row's own pair redemption is the one in flight -- only affects the button's label. */
  redeemingPair?: boolean;
  /** Any redemption or mint anywhere on the page is in flight: both buttons here are disabled, whether or not this row is the one running (Wave R4 review item 4 -- one busy state covers every redeem/mint action). */
  busy?: boolean;
  /** True while the wallet's trade history is still syncing, so cost basis and P&L are not yet known. */
  costBasisPending?: boolean;
};

/** A small rounded badge for a holding amount, e.g. "Yes — qty 2". Chip styling only -- the text itself is asserted by `e2e/trade.spec.ts`, so it stays exact. */
function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-surface-raised px-3 py-1 text-sm">{children}</span>;
}

function stateBadge(row: PositionRowData, nowSeconds: number): { label: string; className: string } {
  if (row.state === "settled") {
    return { label: "Settled", className: "bg-surface-raised text-text-muted" };
  }
  if (Number(row.closeTs) <= nowSeconds) {
    return { label: "Closed, settling", className: "bg-warning/15 text-warning" };
  }
  return { label: "Open", className: "bg-success/15 text-success" };
}

/** One market's line in the Portfolio page: open/settled badge, a single "Minted pair" line for the matched portion, any one-sided Yes/No balance, and the redeem actions each balance is eligible for. */
export function PositionRow({ row, onRedeemWinning, onRedeemPair, redeemingWinning, redeemingPair, busy, costBasisPending }: PositionRowProps) {
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

  const nowSeconds = Math.floor(Date.now() / 1000);
  const badge = stateBadge(row, nowSeconds);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">
          {row.ticker} {formatStrike(row.strike)}
          {row.tradingDay !== undefined ? <span className="ml-2 font-normal text-text-muted">· {formatTradingDay(row.tradingDay)}</span> : null}
        </span>
        <span className="flex items-center gap-3 text-sm">
          <span className={`rounded-full px-2 py-0.5 text-xs ${badge.className}`}>{badge.label}</span>
          {row.state === "settled" ? null : (
            <Link href={`/trade/${row.ticker}`} className="text-cyan underline">
              Trade
            </Link>
          )}
        </span>
      </div>

      {row.state === "settled" && row.settlementPriceMicro !== undefined && row.winningSide ? (
        <div className="text-sm text-text-muted">
          Settled at {formatUsd(row.settlementPriceMicro)} — {row.winningSide === "yes" ? "Yes" : "No"} won
        </div>
      ) : null}

      {row.pairsHeld > 0n || yesOnly > 0n || noOnly > 0n ? (
        <div className="flex flex-wrap items-center gap-2">
          {row.pairsHeld > 0n ? <Chip>Pairs — qty {row.pairsHeld.toString()}</Chip> : null}
          {yesOnly > 0n ? <Chip>Yes — qty {yesOnly.toString()}</Chip> : null}
          {noOnly > 0n ? <Chip>No — qty {noOnly.toString()}</Chip> : null}
        </div>
      ) : null}

      {row.pairsHeld > 0n && row.canRedeemPair && onRedeemPair ? (
        <div>
          <button
            type="button"
            onClick={onRedeemPair}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:border-text-muted disabled:opacity-60"
          >
            {redeemingPair ? "Redeeming…" : "Redeem pair"}
          </button>
        </div>
      ) : null}

      {row.canRedeemWinning && onRedeemWinning ? (
        <div>
          <button
            type="button"
            onClick={onRedeemWinning}
            disabled={busy}
            className="rounded-md bg-indigo px-3 py-1.5 text-sm font-medium text-on-brand disabled:opacity-60"
          >
            {redeemingWinning ? "Redeeming…" : "Redeem winning"}
          </button>
        </div>
      ) : null}

      {row.restingYes > 0n ? (
        <div className="text-sm text-text-muted">Yes open on the book — qty {row.restingYes.toString()}</div>
      ) : null}

      <div className="num text-sm text-text-muted">
        {costBasisPending
          ? "Cost basis updating…"
          : `Cost basis ${formatUsd(row.costBasisMicro)} · Realized P&L ${formatUsd(row.realizedPnlMicro)}`}
      </div>
    </Card>
  );
}
