"use client";

/** The wallet's resting orders on the selected market's book, with Cancel (T065). */

import { useState } from "react";
import type { Order } from "@meridian/sdk";
import { formatPrice } from "@/lib/format";
import { CANCEL, CANCELLING } from "@/lib/trade-copy";

export type OrderListProps = {
  /** This wallet's resting orders (bids then asks), from `usePosition`. */
  orders: Order[];
  /** Order ids that are asks (Sell Yes); everything else is a bid (Buy Yes). */
  askIds?: Set<string>;
  /** `"yes"` for a bid (buying Yes) or ask (selling Yes); callers pass `bids`/`asks` already tagged. */
  onCancel: (order: Order) => void;
  /** True while a cancel is in flight for any order (disables every Cancel button). */
  cancelling?: boolean;
};

export function OrderList({ orders, onCancel, cancelling, askIds }: OrderListProps) {
  const [pendingId, setPendingId] = useState<bigint | null>(null);

  if (orders.length === 0) {
    return <p className="text-text-muted">No open orders.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th className="px-3 py-2 font-medium">Order</th>
            <th className="px-3 py-2 font-medium">Side</th>
            <th className="px-3 py-2 font-medium">Price</th>
            <th className="px-3 py-2 font-medium">Open qty</th>
            <th className="px-3 py-2 font-medium">Reserved</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const isAsk = askIds?.has(order.id.toString()) ?? false;
            // Reserved collateral for a resting bid is price * remaining (micro-USDC);
            // a resting ask reserves the Yes tokens themselves, not USDC.
            const reserved = isAsk ? `${order.remaining.toString()} Yes` : formatPrice(order.price * order.remaining);
            return (
              <tr key={order.id.toString()} className="border-t border-border/40">
                <td className="num px-3 py-2">#{order.id.toString()}</td>
                <td className="px-3 py-2">{isAsk ? "Sell Yes" : "Buy Yes"}</td>
                <td className="num px-3 py-2">{formatPrice(order.price)}</td>
                <td className="num px-3 py-2">{order.remaining.toString()}</td>
                <td className="num px-3 py-2">{reserved}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    className="rounded-sm border border-border px-2 py-1 text-xs text-text-muted hover:border-no/50 hover:text-no disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={cancelling === true}
                    onClick={() => {
                      setPendingId(order.id);
                      onCancel(order);
                    }}
                  >
                    {cancelling === true && pendingId === order.id ? CANCELLING : CANCEL}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
