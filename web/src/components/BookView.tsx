"use client";

import { formatPrice } from "@/lib/format";
import { bestAsk, bestBid, spread, toPerspective, type BookLevel, type Perspective } from "@/lib/book-perspective";

export type BookViewProps = {
  bids: BookLevel[];
  asks: BookLevel[];
  perspective: Perspective;
  onToggle: (perspective: Perspective) => void;
};

export function BookView({ bids, asks, perspective, onToggle }: BookViewProps) {
  const view = toPerspective(bids, asks, perspective);
  const bid = bestBid(view.bids);
  const ask = bestAsk(view.asks);
  const spreadMicro = spread(view.bids, view.asks);
  const empty = view.bids.length === 0 && view.asks.length === 0;

  return (
    <div>
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={perspective === "yes"}
          onClick={() => onToggle("yes")}
        >
          Yes
        </button>
        <button
          type="button"
          aria-pressed={perspective === "no"}
          onClick={() => onToggle("no")}
        >
          No
        </button>
      </div>

      <div className="mt-2 flex gap-4 text-sm">
        <span>Best bid {bid ? formatPrice(bid.price) : "—"}</span>
        <span>Best ask {ask ? formatPrice(ask.price) : "—"}</span>
        <span>Spread {spreadMicro !== undefined ? formatPrice(spreadMicro) : "—"}</span>
      </div>

      {empty ? (
        <p className="mt-2">No orders yet</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">Bid qty</th>
              <th className="text-left">Bid price</th>
              <th className="text-left">Ask price</th>
              <th className="text-left">Ask qty</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: Math.max(view.bids.length, view.asks.length) }).map((_, i) => (
              <tr key={i}>
                <td>{view.bids[i] ? view.bids[i].qty.toString() : ""}</td>
                <td>{view.bids[i] ? formatPrice(view.bids[i].price) : ""}</td>
                <td>{view.asks[i] ? formatPrice(view.asks[i].price) : ""}</td>
                <td>{view.asks[i] ? view.asks[i].qty.toString() : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
