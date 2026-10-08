"use client";

/**
 * T082 / deferred Wave 5 review item: a table of the wallet's resting
 * orders across every market -- every ticker, every trading day -- with
 * Cancel per row and "Cancel all on this market". Grouped the way
 * `maker-view.ts`'s `groupMyOrderRows` orders them: most recent trading
 * day first, then ticker; strikes are listed within each group.
 */

import { formatPrice, formatStrike, formatUsd, formatTradingDay } from "@/lib/format";
import { groupMyOrderRows, type MyOrderRow } from "@/lib/maker-view";
import { CANCEL, CANCELLING } from "@/lib/trade-copy";

export type MyOrdersProps = {
  rows: readonly MyOrderRow[];
  onCancel: (row: MyOrderRow) => void | Promise<void>;
  onCancelAllOnMarket: (marketKey: string) => void | Promise<void>;
  /** `order:<marketKey>:<orderId>` or `market:<marketKey>` currently in flight, or `null`. */
  cancelling?: string | null;
  /** `useMyOrders`' `error`: a Book fetch failed for at least one market, so `rows` may be stale (item 17). */
  error?: boolean;
};

const SIDE_LABEL: Record<MyOrderRow["side"], string> = {
  bid: "Buy Yes",
  ask: "Sell Yes",
};

function lockedLabel(row: MyOrderRow): string {
  if (row.side === "bid") {
    return `${formatUsd(row.lockedUsdcMicro ?? 0n)} locked`;
  }
  return `${(row.lockedYesQty ?? 0n).toString()} Yes locked`;
}

/** Rows within one group, further split by market (strike), each with its own "Cancel all" action. */
function marketSections(rows: readonly MyOrderRow[]): Array<{ marketKey: string; strike: bigint; rows: MyOrderRow[] }> {
  const sections: Array<{ marketKey: string; strike: bigint; rows: MyOrderRow[] }> = [];
  for (const row of rows) {
    const last = sections[sections.length - 1];
    if (last !== undefined && last.marketKey === row.marketKey) {
      last.rows.push(row);
    } else {
      sections.push({ marketKey: row.marketKey, strike: row.strike, rows: [row] });
    }
  }
  return sections;
}

export function MyOrders({ rows, onCancel, onCancelAllOnMarket, cancelling, error }: MyOrdersProps) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-muted">Resting orders</h3>
        <p className="text-sm text-text-muted">No resting orders.</p>
        {error ? <p className="text-sm text-no">Could not load some orders.</p> : null}
      </div>
    );
  }

  const groups = groupMyOrderRows(rows);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-text-muted">Resting orders</h3>
      {error ? <p className="text-sm text-no">Could not load some orders.</p> : null}
      {groups.map((group) => (
        <div key={`${group.tradingDay}:${group.ticker}`} className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            {group.ticker} — {formatTradingDay(group.tradingDay)}
          </span>
          {marketSections(group.rows).map((section) => (
            <div key={section.marketKey} className="flex flex-col gap-1 border border-border p-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-muted">Strike {formatStrike(section.strike)}</span>
                <button
                  type="button"
                  disabled={cancelling !== null && cancelling !== undefined}
                  onClick={() => onCancelAllOnMarket(section.marketKey)}
                >
                  {cancelling === `market:${section.marketKey}` ? CANCELLING : "Cancel all on this market"}
                </button>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">Side</th>
                    <th className="text-left">Price</th>
                    <th className="text-left">Remaining</th>
                    <th className="text-left">Locked</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row) => {
                    const key = `order:${row.marketKey}:${row.orderId.toString()}`;
                    const busy = cancelling !== null && cancelling !== undefined;
                    return (
                      <tr key={key}>
                        <td>{SIDE_LABEL[row.side]}</td>
                        <td>{formatPrice(row.price)}</td>
                        <td>{row.remaining.toString()}</td>
                        <td>{lockedLabel(row)}</td>
                        <td>
                          <button type="button" disabled={busy} onClick={() => onCancel(row)}>
                            {cancelling === key ? CANCELLING : CANCEL}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
