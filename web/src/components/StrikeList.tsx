"use client";

/**
 * All of today's strikes for a ticker (T065), each showing its Yes/No best
 * price, Chance (best ask, else last bid) and payout multiple; selecting
 * one drives the Trade page's `BookView`/`TradePanel`. Best prices here
 * are a periodic snapshot (15s poll of each strike's `Book`), not a live
 * subscription -- the selected strike's book is already live via `useBook`
 * in `BookView`/`TradePanel`, so this list only needs to be fresh enough to
 * pick a strike by.
 */

import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { bookPda, decodeBook, type Book } from "@meridian/sdk";
import { formatPrice, formatStrike, impliedProbability, oppositePrice, payoutMultiple } from "@/lib/format";
import { groupStrikesBySettlement } from "@/lib/markets";
import { representativeYesQuote } from "@/lib/book-quote";
import { PROGRAM_ID } from "@/lib/rpc";
import type { MarketAccount } from "@/hooks/useMarkets";
import { useProgram } from "@/hooks/useProgram";

export type StrikeListProps = {
  markets: MarketAccount[];
  selected: PublicKey | null;
  onSelect: (market: MarketAccount) => void;
  /** The ticker's live price, for highlighting the at-the-money row (nearest strike). */
  lastPriceMicro?: bigint;
};

const REFRESH_INTERVAL_MS = 15_000;

/** The market whose strike is numerically closest to `lastPriceMicro`, or `null` with no price yet / no markets. */
function atTheMoneyKey(markets: MarketAccount[], lastPriceMicro: bigint | undefined): string | null {
  if (lastPriceMicro === undefined || markets.length === 0) {
    return null;
  }
  let best = markets[0];
  let bestDiff = best.strike < lastPriceMicro ? lastPriceMicro - best.strike : best.strike - lastPriceMicro;
  for (const market of markets) {
    const diff = market.strike < lastPriceMicro ? lastPriceMicro - market.strike : market.strike - lastPriceMicro;
    if (diff < bestDiff) {
      best = market;
      bestDiff = diff;
    }
  }
  return best.pubkey.toBase58();
}

export function StrikeList({ markets, selected, onSelect, lastPriceMicro }: StrikeListProps) {
  const program = useProgram();
  const [books, setBooks] = useState<Record<string, Book | null>>({});
  const [settledExpanded, setSettledExpanded] = useState(false);

  const selectedKey = selected?.toBase58() ?? null;
  useEffect(() => {
    if (selectedKey === null) {
      return;
    }
    const market = markets.find((m) => m.pubkey.toBase58() === selectedKey);
    if (market?.state === "settled") {
      setSettledExpanded(true);
    }
    // Only ever auto-*expands* (never auto-collapses) when the selected strike
    // turns out to be a settled one, so the selection stays visible; `markets`
    // itself isn't a dependency since it's a new array every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  useEffect(() => {
    let cancelled = false;
    const connection = program.provider.connection;

    async function loadAll() {
      const entries = await Promise.all(
        markets.map(async (market) => {
          try {
            const [pda] = bookPda(PROGRAM_ID, market.pubkey);
            const accountInfo = await connection.getAccountInfo(pda, "confirmed");
            const book = accountInfo === null ? null : decodeBook(Uint8Array.from(accountInfo.data));
            return [market.pubkey.toBase58(), book] as const;
          } catch {
            return [market.pubkey.toBase58(), null] as const;
          }
        }),
      );
      if (!cancelled) {
        setBooks(Object.fromEntries(entries));
      }
    }

    void loadAll();
    const interval = setInterval(loadAll, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // `markets` is a new array each `useMarkets` poll; keying off its pubkeys
    // (not the array identity) avoids re-fetching every book on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, markets.map((m) => m.pubkey.toBase58()).join(",")]);

  if (markets.length === 0) {
    return <p className="text-text-muted">No contracts yet today.</p>;
  }

  const atmKey = atTheMoneyKey(markets, lastPriceMicro);
  const groups = groupStrikesBySettlement(markets);
  // A divider only earns its place once there's something on both sides of
  // it to separate; once every strike has settled (the trading day is done)
  // there's nothing left to separate it from, so the list renders flat, same
  // as before this grouping existed.
  const showDivider = !groups.allSettled && groups.open.length > 0 && groups.settled.length > 0;

  function selectRow(market: MarketAccount) {
    onSelect(market);
  }

  function renderRow(market: MarketAccount) {
    const key = market.pubkey.toBase58();
    const quote = representativeYesQuote(books[key] ?? null);
    const isSelected = selected !== null && selected.equals(market.pubkey);
    const isAtm = atmKey === key;
    const isSettled = market.state === "settled";
    const rowClasses = [
      "cursor-pointer border-b border-border/60 last:border-b-0 outline-none focus-visible:ring-2 focus-visible:ring-focus",
      isSelected ? "bg-surface-raised" : isAtm ? "bg-cyan/5" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <tr
        key={key}
        role="row"
        tabIndex={0}
        aria-selected={isSelected}
        onClick={() => selectRow(market)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectRow(market);
          }
        }}
        className={rowClasses}
      >
        <td className="num px-3 py-2">
          {formatStrike(market.strike)}
          {isAtm ? <span className="ml-2 rounded-sm bg-cyan/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan">Near price</span> : null}
        </td>
        <td className="num px-3 py-2">
          {isSettled ? (
            <span className={market.outcome === "yes" ? "font-medium text-yes" : "text-text-muted"}>
              {market.outcome === "yes" ? "Yes won" : "—"}
            </span>
          ) : (
            (quote !== undefined ? formatPrice(quote.price) : "—")
          )}
        </td>
        <td className="num px-3 py-2">
          {isSettled ? (
            <span className={market.outcome === "no" ? "font-medium text-no" : "text-text-muted"}>
              {market.outcome === "no" ? "No won" : "—"}
            </span>
          ) : (
            (quote !== undefined ? formatPrice(oppositePrice(quote.price)) : "—")
          )}
        </td>
        <td className="num px-3 py-2">
          {!isSettled && quote !== undefined ? (
            <div className="flex flex-col">
              <span>{impliedProbability(quote.price)}</span>
              <span className="text-[10px] font-normal text-text-muted">{quote.fromAsk ? "to buy Yes" : "last bid"}</span>
            </div>
          ) : (
            "—"
          )}
        </td>
        <td className="num px-3 py-2">{!isSettled && quote !== undefined ? payoutMultiple(quote.price) : "—"}</td>
      </tr>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th className="px-3 py-2 font-medium">Strike</th>
            <th className="px-3 py-2 font-medium">Yes</th>
            <th className="px-3 py-2 font-medium">No</th>
            <th className="px-3 py-2 font-medium" title="Best price to buy Yes; shows the last bid when no one is offering to sell Yes yet">
              Chance
            </th>
            <th className="px-3 py-2 font-medium">Payout</th>
          </tr>
        </thead>
        <tbody>
          {groups.allSettled ? (
            groups.settled.map((market) => renderRow(market))
          ) : (
            <>
              {groups.open.map((market) => renderRow(market))}
              {showDivider ? (
                <tr key="settled-divider" className="border-b border-border/60 bg-surface-raised/40">
                  <td className="px-3 py-1.5 text-xs text-text-muted" colSpan={5}>
                    <div className="flex items-center gap-2">
                      <span>Settled</span>
                      <button
                        type="button"
                        aria-expanded={settledExpanded}
                        onClick={() => setSettledExpanded((prev) => !prev)}
                        className="text-xs font-medium text-cyan outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        {settledExpanded ? "Hide settled" : `${groups.settled.length} settled strikes`}
                      </button>
                    </div>
                  </td>
                </tr>
              ) : null}
              {showDivider && settledExpanded ? groups.settled.map((market) => renderRow(market)) : null}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
