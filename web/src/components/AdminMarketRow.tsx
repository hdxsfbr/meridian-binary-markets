"use client";

/**
 * One row of `/admin`'s "Unsettled markets" table: ticker, strike, closed
 * since, the automation service's attempts/lastError/nextRetry (or "Status
 * unavailable"), and an override form whose button stays disabled until
 * `closeTs + overrideDelaySecs`, showing the enable time in ET
 * (contracts/frontend.md).
 */

import { useState } from "react";
import { formatStrike } from "@/lib/format";
import { formatDuration, formatEt, overrideAvailability, type MergedMarketRow } from "@/lib/admin-view";

export type AdminMarketRowProps = {
  row: MergedMarketRow;
  overrideDelaySecs: number;
  now: number;
  statusUnavailable: boolean;
  onOverride: (priceDollars: string) => Promise<void> | void;
  submitting?: boolean;
};

export function AdminMarketRow({ row, overrideDelaySecs, now, statusUnavailable, onOverride, submitting }: AdminMarketRowProps) {
  const [price, setPrice] = useState("");
  const availability = overrideAvailability(row.closeTs, overrideDelaySecs, now);

  return (
    <tr className="border-b border-border">
      <td className="py-2 pr-4">{row.ticker}</td>
      <td className="py-2 pr-4">{formatStrike(row.strike)}</td>
      <td className="py-2 pr-4">{formatDuration(row.closedForSecs)}</td>
      <td className="py-2 pr-4">
        {statusUnavailable || row.status === undefined ? (
          <span className="text-text-muted">Status unavailable</span>
        ) : (
          <span>
            {row.status.attempts} attempt{row.status.attempts === 1 ? "" : "s"}
            {row.status.lastError ? ` — ${row.status.lastError}` : ""}
            {row.status.nextRetryAt !== null ? ` — next retry ${formatEt(row.status.nextRetryAt)}` : ""}
          </span>
        )}
      </td>
      <td className="py-2 pr-4">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onOverride(price);
          }}
        >
          <input
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Settlement price ($)"
            className="min-h-10 w-36 rounded-md border border-border px-2 py-1"
            disabled={!availability.available || submitting}
          />
          <button
            type="submit"
            disabled={!availability.available || price.trim() === "" || submitting}
            className="min-h-10 rounded-md border border-border px-3 py-1 disabled:opacity-50"
          >
            Override
          </button>
          {!availability.available ? (
            <span className="text-text-muted text-sm">Available at {formatEt(availability.availableAt)}</span>
          ) : null}
        </form>
      </td>
    </tr>
  );
}
