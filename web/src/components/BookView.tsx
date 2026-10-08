"use client";

/** Compact order book: bid size / bid price / mid / ask price / ask size, Yes/No perspective toggle, depth bars. */

import { formatPrice } from "@/lib/format";
import { bestAsk, bestBid, spread, toPerspective, type BookLevel, type Perspective } from "@/lib/book-perspective";

export type BookViewProps = {
  bids: BookLevel[];
  asks: BookLevel[];
  perspective: Perspective;
  onToggle: (perspective: Perspective) => void;
};

function depthPercent(qty: bigint, max: bigint): number {
  if (max <= 0n) {
    return 0;
  }
  const pct = Number((qty * 100n) / max);
  return Math.min(100, Math.max(0, pct));
}

export function BookView({ bids, asks, perspective, onToggle }: BookViewProps) {
  const view = toPerspective(bids, asks, perspective);
  const bid = bestBid(view.bids);
  const ask = bestAsk(view.asks);
  const spreadMicro = spread(view.bids, view.asks);
  const empty = view.bids.length === 0 && view.asks.length === 0;
  const rowCount = Math.max(view.bids.length, view.asks.length);
  const maxQty = [...view.bids, ...view.asks].reduce((m, level) => (level.qty > m ? level.qty : m), 0n);
  const midMicro = bid !== undefined && ask !== undefined ? (bid.price + ask.price) / 2n : undefined;

  return (
    <div>
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={perspective === "yes"}
          onClick={() => onToggle("yes")}
          className={`rounded-sm border px-3 py-1 text-sm ${perspective === "yes" ? "border-yes bg-yes/15 text-yes" : "border-border text-text-muted"}`}
        >
          Yes
        </button>
        <button
          type="button"
          aria-pressed={perspective === "no"}
          onClick={() => onToggle("no")}
          className={`rounded-sm border px-3 py-1 text-sm ${perspective === "no" ? "border-no bg-no/15 text-no" : "border-border text-text-muted"}`}
        >
          No
        </button>
      </div>

      <div className="num mt-2 flex gap-4 text-sm">
        <span>
          Best bid <span className="text-text-muted">{bid ? formatPrice(bid.price) : "—"}</span>
        </span>
        <span>
          Best ask <span className="text-text-muted">{ask ? formatPrice(ask.price) : "—"}</span>
        </span>
        <span>
          Spread <span className="text-text-muted">{spreadMicro !== undefined ? formatPrice(spreadMicro) : "—"}</span>
        </span>
      </div>

      {empty ? (
        <p className="mt-2 text-text-muted">No orders yet</p>
      ) : (
        <table className="mt-2 w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted">
              <th className="px-2 py-1 font-medium">Bid size</th>
              <th className="px-2 py-1 font-medium">Bid</th>
              <th className="px-2 py-1 text-center font-medium">Mid</th>
              <th className="px-2 py-1 font-medium">Ask</th>
              <th className="px-2 py-1 font-medium">Ask size</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }).map((_, i) => {
              const bidLevel = view.bids[i];
              const askLevel = view.asks[i];
              return (
                <tr key={i} className="border-t border-border/40">
                  <td className="relative px-2 py-1">
                    {bidLevel ? (
                      <>
                        <span
                          className="absolute inset-y-0 right-0 bg-yes/10"
                          style={{ width: `${depthPercent(bidLevel.qty, maxQty)}%` }}
                          aria-hidden="true"
                        />
                        <span className="num relative">{bidLevel.qty.toString()}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="num px-2 py-1">{bidLevel ? formatPrice(bidLevel.price) : ""}</td>
                  <td className="num px-2 py-1 text-center text-text-muted">
                    {i === 0 && midMicro !== undefined ? formatPrice(midMicro) : ""}
                  </td>
                  <td className="num px-2 py-1">{askLevel ? formatPrice(askLevel.price) : ""}</td>
                  <td className="relative px-2 py-1">
                    {askLevel ? (
                      <>
                        <span
                          className="absolute inset-y-0 left-0 bg-no/10"
                          style={{ width: `${depthPercent(askLevel.qty, maxQty)}%` }}
                          aria-hidden="true"
                        />
                        <span className="num relative">{askLevel.qty.toString()}</span>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
