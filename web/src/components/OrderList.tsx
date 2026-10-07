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
    return <p className="text-black/70">No open orders.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th className="text-left">Order</th>
          <th className="text-left">Side</th>
          <th className="text-left">Price</th>
          <th className="text-left">Remaining</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id.toString()}>
            <td>#{order.id.toString()}</td>
            <td>{askIds?.has(order.id.toString()) ? "Sell Yes" : "Buy Yes"}</td>
            <td>{formatPrice(order.price)}</td>
            <td>{order.remaining.toString()}</td>
            <td>
              <button
                type="button"
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
        ))}
      </tbody>
    </table>
  );
}
