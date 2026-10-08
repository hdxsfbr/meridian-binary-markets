"use client";

/**
 * T082 / deferred Wave 5 review item: lets a market maker post resting Yes
 * bids/asks across several strikes in one sitting. Each "Add to queue"
 * queues one quote (ticker/strike, side, price, quantity) after validating
 * inventory; "Submit queued quotes" then sends them one at a time via
 * `onSubmitQuote` (the page's `@/lib/tx` `placeOrder` + `sendTx` call),
 * updating each row's own status rather than one page-wide spinner.
 */

import { useState } from "react";
import type { Book } from "@meridian/sdk";
import { formatStrike, formatUsd, marketOptionLabel, defaultMarketKey } from "@/lib/format";
import type { MarketLike } from "@/lib/positions-view";

export type QuoteSide = "bid" | "ask";

type QueuedQuote = {
  id: number;
  market: MarketLike;
  side: QuoteSide;
  priceMicro: bigint;
  qty: bigint;
  status: "queued" | "sending" | "done" | "error";
  error?: string;
};

export type MakerQuoteFormProps = {
  /** Today's open markets a quote can be posted in. */
  openMarkets: readonly MarketLike[];
  /** Yes available (not already resting) per market, whole contracts -- what an ask can draw on. */
  availableYesByMarket: ReadonlyMap<string, bigint>;
  /** The wallet's available USDC, micro-USDC -- what a bid's escrow draws on. */
  availableUsdcMicro: bigint;
  /** Decoded `Book` per market (base58), from `useMyOrders` -- used to refuse a quote that would cross and trade immediately (item 14). */
  booksByMarket: ReadonlyMap<string, Book | null>;
  /** Sends one limit order; throws a user-facing message on failure. */
  onSubmitQuote: (market: MarketLike, side: QuoteSide, priceMicro: bigint, qty: bigint) => Promise<void>;
  /** Trading is paused: queuing and submitting are both disabled. */
  disabled?: boolean;
};

const SIDE_OPTIONS: Array<{ value: QuoteSide; label: string }> = [
  { value: "bid", label: "Offer to buy Yes at" },
  { value: "ask", label: "Offer to sell Yes at" },
];

let nextId = 1;

/** Parses a dollar-decimal price in `[0.01, 0.99]` to micro-USDC; `undefined` for anything else. */
function parsePriceMicro(input: string): bigint | undefined {
  const trimmed = input.trim();
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") {
    return undefined;
  }
  const [wholeStr, fracStr = ""] = trimmed.split(".");
  const whole = wholeStr === "" ? 0n : BigInt(wholeStr);
  const frac = BigInt((fracStr + "000000").slice(0, 6) || "0");
  const micro = whole * 1_000_000n + frac;
  if (micro < 10_000n || micro > 990_000n) {
    return undefined;
  }
  return micro;
}

function parseQty(input: string): bigint | undefined {
  if (!/^\d+$/.test(input)) {
    return undefined;
  }
  const value = BigInt(input);
  return value > 0n ? value : undefined;
}

/**
 * Item 14: a bid at or above the best resting ask (or an ask at or below
 * the best resting bid) would trade immediately against the book rather
 * than rest -- this form has no way to supply the matched counterparties'
 * token accounts as remaining accounts, so such a quote is refused before
 * it ever reaches wallet approval. `undefined` book (not yet fetched) is
 * treated as "nothing to check against" -- the submit step still goes
 * through the program, which enforces this regardless.
 */
function wouldCross(book: Book | null | undefined, side: QuoteSide, priceMicro: bigint): boolean {
  if (!book) {
    return false;
  }
  if (side === "bid") {
    const bestAsk = book.asks.reduce<bigint | undefined>(
      (min, order) => (min === undefined || order.price < min ? order.price : min),
      undefined,
    );
    return bestAsk !== undefined && priceMicro >= bestAsk;
  }
  const bestBid = book.bids.reduce<bigint | undefined>(
    (max, order) => (max === undefined || order.price > max ? order.price : max),
    undefined,
  );
  return bestBid !== undefined && priceMicro <= bestBid;
}

/** Item 16: USDC (bids) or Yes (asks) already reserved by this market/side's still-pending queued quotes. */
function queuedReservation(queue: readonly QueuedQuote[], marketKey: string, side: QuoteSide): bigint {
  return queue
    .filter((q) => q.market.pubkey.toBase58() === marketKey && q.side === side && q.status !== "done")
    .reduce((sum, q) => sum + (side === "bid" ? q.priceMicro * q.qty : q.qty), 0n);
}

/** "Reserves $X" for a bid's USDC escrow, or "Reserves N Yes" for an ask's token escrow -- never a dollar sign on a Yes-token lock, and never "filled" (contracts/frontend.md copy rule). */
function escrowCopy(side: QuoteSide, priceMicro: bigint, qty: bigint): string {
  if (side === "bid") {
    return `Reserves ${formatUsd(priceMicro * qty)} until it trades or you cancel.`;
  }
  return `Reserves ${qty.toString()} Yes until it trades or you cancel.`;
}

export function MakerQuoteForm({
  openMarkets,
  availableYesByMarket,
  availableUsdcMicro,
  booksByMarket,
  onSubmitQuote,
  disabled,
}: MakerQuoteFormProps) {
  const [marketKey, setMarketKey] = useState<string>(defaultMarketKey(openMarkets));
  const [side, setSide] = useState<QuoteSide>("bid");
  const [priceInput, setPriceInput] = useState("");
  const [qtyInput, setQtyInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedQuote[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const selected = openMarkets.find((m) => m.pubkey.toBase58() === marketKey) ?? openMarkets[0];
  const priceMicro = parsePriceMicro(priceInput);
  const qty = parseQty(qtyInput);

  function addToQueue(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!selected) {
      setFormError("Pick a strike first.");
      return;
    }
    if (priceMicro === undefined) {
      setFormError("Enter a price between $0.01 and $0.99.");
      return;
    }
    if (qty === undefined) {
      setFormError("Enter a quantity greater than zero.");
      return;
    }
    const selectedKey = selected.pubkey.toBase58();
    if (wouldCross(booksByMarket.get(selectedKey), side, priceMicro)) {
      setFormError("This price would trade immediately. Use the Trade page for that.");
      return;
    }

    if (side === "ask") {
      const availableYes = availableYesByMarket.get(selectedKey) ?? 0n;
      const reserved = queuedReservation(queue, selectedKey, "ask");
      const remainingYes = availableYes - reserved;
      if (qty > remainingYes) {
        setFormError(`Not enough Yes to offer: ${(remainingYes > 0n ? remainingYes : 0n).toString()} available.`);
        return;
      }
    } else {
      const required = priceMicro * qty;
      const reserved = queuedReservation(queue, selectedKey, "bid");
      const remainingUsdc = availableUsdcMicro - reserved;
      if (required > remainingUsdc) {
        setFormError(`Not enough USDC to lock: this quote needs ${formatUsd(required)}.`);
        return;
      }
    }

    setQueue((prev) => [
      ...prev,
      { id: nextId++, market: selected, side, priceMicro, qty, status: "queued" },
    ]);
    setQtyInput("");
  }

  function removeFromQueue(id: number) {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  }

  async function submitQueue() {
    setSubmitting(true);
    for (const item of queue) {
      if (item.status === "done") {
        continue;
      }
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "sending", error: undefined } : q)));
      try {
        await onSubmitQuote(item.market, item.side, item.priceMicro, item.qty);
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "done" } : q)));
      } catch (err) {
        const message = err instanceof Error ? err.message : "This quote did not go through.";
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "error", error: message } : q)));
      }
    }
    setSubmitting(false);
  }

  const hasPending = queue.some((q) => q.status === "queued" || q.status === "error");
  const fieldClass =
    "rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold text-text-muted">Place quotes</h3>

      <form onSubmit={addToQueue} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Strike
          <select
            value={marketKey || (selected?.pubkey.toBase58() ?? "")}
            onChange={(e) => setMarketKey(e.target.value)}
            disabled={disabled || openMarkets.length === 0}
            className={fieldClass}
          >
            {openMarkets.map((m) => (
              <option key={m.pubkey.toBase58()} value={m.pubkey.toBase58()}>
                {marketOptionLabel(m, openMarkets)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Side
          <select value={side} onChange={(e) => setSide(e.target.value as QuoteSide)} disabled={disabled} className={fieldClass}>
            {SIDE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Price ($0.01–$0.99)
          <input
            type="text"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            disabled={disabled}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Quantity
          <input
            type="text"
            inputMode="numeric"
            value={qtyInput}
            onChange={(e) => setQtyInput(e.target.value)}
            disabled={disabled}
            className={fieldClass}
          />
        </label>
        <button
          type="submit"
          disabled={disabled || openMarkets.length === 0}
          className="rounded-md border border-indigo px-4 py-1.5 text-sm font-medium text-indigo disabled:opacity-60"
        >
          {disabled ? "Trading is paused" : "Add to queue"}
        </button>
      </form>

      {priceMicro !== undefined && qty !== undefined ? (
        <p className="text-sm text-text-muted">{escrowCopy(side, priceMicro, qty)}</p>
      ) : null}
      {formError !== null ? <p className="text-sm text-no">{formError}</p> : null}

      {queue.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="text-text-muted">
                  <th className="py-1 pr-3 font-medium">Strike</th>
                  <th className="py-1 pr-3 font-medium">Side</th>
                  <th className="py-1 pr-3 font-medium">Price</th>
                  <th className="py-1 pr-3 font-medium">Qty</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr key={item.id} className="border-t border-border">
                    <td className="num py-1.5 pr-3">
                      {item.market.ticker} {formatStrike(item.market.strike)}
                    </td>
                    <td className="py-1.5 pr-3">{item.side === "bid" ? "Buy Yes" : "Sell Yes"}</td>
                    <td className="num py-1.5 pr-3">{formatUsd(item.priceMicro)}</td>
                    <td className="num py-1.5 pr-3">{item.qty.toString()}</td>
                    <td className="py-1.5 pr-3">
                      {item.status === "queued" ? "Queued" : null}
                      {item.status === "sending" ? "Sending…" : null}
                      {item.status === "done" ? "Posted" : null}
                      {item.status === "error" ? item.error ?? "Failed" : null}
                    </td>
                    <td className="py-1.5 pr-3">
                      {item.status === "queued" || item.status === "error" ? (
                        <button
                          type="button"
                          onClick={() => removeFromQueue(item.id)}
                          disabled={submitting}
                          className="rounded-md border border-border px-2 py-1 text-xs hover:border-text-muted disabled:opacity-60"
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            disabled={disabled || submitting || !hasPending}
            onClick={() => void submitQueue()}
            className="self-start rounded-md bg-indigo px-4 py-1.5 text-sm font-medium text-on-brand disabled:opacity-60"
          >
            {submitting ? "Submitting…" : "Submit queued quotes"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
