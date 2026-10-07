"use client";

/**
 * Live view of a market's `Book` account (T062, FR-011): initial fetch plus
 * an `onAccountChange` subscription, decoded with `@meridian/sdk`'s
 * `decodeBook` (raw bytes, not the Anchor account coder — `Book` is a
 * fixed-layout buffer, not a Borsh struct the IDL declares). Returns bids
 * and asks in Yes terms (book.ts's convention); perspective flipping is
 * `web/src/lib/book-perspective.ts`'s job, not this hook's.
 */

import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { bookPda, decodeBook, type Book, type BookHeader, type Order } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { useProgram } from "./useProgram";

export type UseBookResult = {
  bids: Order[];
  asks: Order[];
  header: BookHeader | null;
  loading: boolean;
  error: boolean;
};

const EMPTY: Order[] = [];

/** The live `Book` for `market`, or an empty/loading result while `market` is `undefined`. */
export function useBook(market: PublicKey | undefined): UseBookResult {
  const program = useProgram();
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    // Reset immediately on market change so a stale snapshot from the
    // previous market is never shown while the new one loads (item 7).
    setBook(null);
    setError(false);

    if (market === undefined) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const connection = program.provider.connection;
    const [pda] = bookPda(PROGRAM_ID, market);

    async function load() {
      try {
        const accountInfo = await connection.getAccountInfo(pda, "confirmed");
        if (cancelled) {
          return;
        }
        if (accountInfo === null) {
          // No book created yet for this market: not an error, just empty.
          setBook(null);
          setError(false);
          setLoading(false);
          return;
        }
        const decoded = decodeBook(Uint8Array.from(accountInfo.data));
        setBook(decoded);
        setError(false);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    }

    setLoading(true);
    void load();

    const subscriptionId = connection.onAccountChange(
      pda,
      (accountInfo: { data: Buffer }) => {
        try {
          const decoded = decodeBook(Uint8Array.from(accountInfo.data));
          if (!cancelled) {
            setBook(decoded);
            setError(false);
          }
        } catch {
          // Transient/partial write mid-update; the next account-change event recovers.
        }
      },
      "confirmed",
    );

    return () => {
      cancelled = true;
      void connection.removeAccountChangeListener(subscriptionId);
    };
  }, [program, market]);

  return {
    bids: book?.bids ?? EMPTY,
    asks: book?.asks ?? EMPTY,
    header: book?.header ?? null,
    loading,
    error,
  };
}
