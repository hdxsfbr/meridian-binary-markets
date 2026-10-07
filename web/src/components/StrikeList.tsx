"use client";

/**
 * All of today's strikes for a ticker (T065), each showing its Yes/No best
 * price and implied probability; selecting one drives the Trade page's
 * `BookView`/`TradePanel`. Best prices here are a periodic snapshot (15s
 * poll of each strike's `Book`), not a live subscription — the selected
 * strike's book is already live via `useBook` in `BookView`/`TradePanel`,
 * so this list only needs to be fresh enough to pick a strike by.
 */

import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { bestAsk, bestBid, bookPda, decodeBook, type Book } from "@meridian/sdk";
import { formatPrice, formatStrike, impliedProbability, oppositePrice } from "@/lib/format";
import { PROGRAM_ID } from "@/lib/rpc";
import type { MarketAccount } from "@/hooks/useMarkets";
import { useProgram } from "@/hooks/useProgram";

export type StrikeListProps = {
  markets: MarketAccount[];
  selected: PublicKey | null;
  onSelect: (market: MarketAccount) => void;
};

const REFRESH_INTERVAL_MS = 15_000;

/** A representative Yes price for the strike row: best ask, else best bid, else undefined (no orders yet). */
function representativeYesPrice(book: Book | null): bigint | undefined {
  if (book === null) {
    return undefined;
  }
  return bestAsk(book)?.price ?? bestBid(book)?.price;
}

export function StrikeList({ markets, selected, onSelect }: StrikeListProps) {
  const program = useProgram();
  const [books, setBooks] = useState<Record<string, Book | null>>({});

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
    return <p className="text-black/70">No contracts yet today.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th className="text-left">Strike</th>
          <th className="text-left">Yes</th>
          <th className="text-left">No</th>
          <th className="text-left">Implied probability</th>
        </tr>
      </thead>
      <tbody>
        {markets.map((market) => {
          const yesPrice = representativeYesPrice(books[market.pubkey.toBase58()] ?? null);
          const isSelected = selected !== null && selected.equals(market.pubkey);
          return (
            <tr
              key={market.pubkey.toBase58()}
              onClick={() => onSelect(market)}
              aria-selected={isSelected}
              className={isSelected ? "cursor-pointer bg-black/5" : "cursor-pointer"}
            >
              <td>{formatStrike(market.strike)}</td>
              <td>{yesPrice !== undefined ? formatPrice(yesPrice) : "—"}</td>
              <td>{yesPrice !== undefined ? formatPrice(oppositePrice(yesPrice)) : "—"}</td>
              <td>{yesPrice !== undefined ? impliedProbability(yesPrice) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
