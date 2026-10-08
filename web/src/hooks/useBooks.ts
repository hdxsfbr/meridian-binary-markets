"use client";

/**
 * Many markets' `Book` accounts at once, read with `getMultipleAccountsInfo`
 * (100 addresses per call, same batching as `usePositions.ts`'s
 * `allMarketInventories`) rather than one `getAccountInfo`/subscription per
 * market (`useBook.ts`'s pattern) -- the Markets page needs a lot of books
 * at once (every strike of every enabled ticker) and the public devnet RPC's
 * per-method call budget is tight, so this hook trades liveness (no
 * subscription; a 15s poll) for a flat, small number of RPC calls.
 *
 * Multiple callers asking for the same (or an overlapping) set of markets in
 * the same tick -- e.g. several `TickerCard`s each wanting their own
 * strikes' books -- share one request via a module-level in-flight-promise
 * cache keyed by the sorted address list, so the Markets page's intended
 * call pattern (one combined `useBooks` call for the whole page) isn't
 * undermined if a caller ends up invoking this per-card instead.
 */

import { useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { bookPda, decodeBook, type Book } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { useProgram } from "./useProgram";

const REFRESH_INTERVAL_MS = 15_000;

const inFlight = new Map<string, Promise<Map<string, Book | null>>>();

function dedupeKey(addresses: readonly string[]): string {
  return [...addresses].sort().join(",");
}

/**
 * Fetches every market's book in batches of 100. A batch's RPC call is
 * allowed to throw (a transient RPC failure): it propagates to the caller
 * rather than being swallowed into nulls here, so a failed fetch never
 * looks like "no book account" -- `null` out of this function means an
 * *absent* account from a *successful* call, nothing else. The caller
 * (`useBooks`) is responsible for keeping the previous snapshot on failure.
 */
async function fetchBooks(connection: Connection, marketKeys: readonly PublicKey[]): Promise<Map<string, Book | null>> {
  const bookAddresses = marketKeys.map((market) => bookPda(PROGRAM_ID, market)[0]);
  const out = new Map<string, Book | null>();
  for (let i = 0; i < bookAddresses.length; i += 100) {
    const slice = bookAddresses.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(slice, "confirmed");
    infos.forEach((info, j) => {
      const market = marketKeys[i + j];
      if (info === null) {
        out.set(market.toBase58(), null);
        return;
      }
      try {
        out.set(market.toBase58(), decodeBook(Uint8Array.from(info.data)));
      } catch {
        out.set(market.toBase58(), null);
      }
    });
  }
  return out;
}

/** Shares one request across every caller asking for the same market set this tick. */
function loadDeduped(connection: Connection, marketKeys: readonly PublicKey[]): Promise<Map<string, Book | null>> {
  const key = dedupeKey(marketKeys.map((m) => m.toBase58()));
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const promise = fetchBooks(connection, marketKeys).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export type UseBooksResult = {
  books: Map<string, Book | null>;
  /** True once the most recent poll failed and `books` is therefore a stale (not current-tick) snapshot, not a blanked one. */
  stale: boolean;
};

/**
 * The `Book` (or `null`, meaning no book account yet from a *successful*
 * call) for every market in `marketKeys`, keyed by base58 address. One
 * `getMultipleAccountsInfo` call per 100 markets, refreshed every 15s; no
 * per-market subscriptions. Pass every market whose quote is needed on a
 * page in a single call (e.g. every strike of every enabled ticker on the
 * Markets page) to keep the call count flat regardless of how many cards
 * render.
 *
 * The effect key is the sorted, de-duplicated set of addresses, not their
 * input order, so a caller that passes the same markets in a different
 * order (e.g. after a re-sort) does not restart polling. A failed poll
 * leaves the previous `books` snapshot untouched and sets `stale`; it never
 * overwrites a market's entry with `null`, since `null` means "no book
 * account", not "we couldn't ask".
 */
export function useBooks(marketKeys: readonly PublicKey[]): UseBooksResult {
  const program = useProgram();
  const [books, setBooks] = useState<Map<string, Book | null>>(new Map());
  const [stale, setStale] = useState(false);
  const keysJoined = Array.from(new Set(marketKeys.map((m) => m.toBase58())))
    .sort()
    .join(",");

  useEffect(() => {
    let cancelled = false;
    const connection: Connection = program.provider.connection;
    const keys = keysJoined === "" ? [] : keysJoined.split(",").map((s) => new PublicKey(s));

    async function load() {
      if (keys.length === 0) {
        if (!cancelled) {
          setBooks(new Map());
          setStale(false);
        }
        return;
      }
      try {
        const result = await loadDeduped(connection, keys);
        if (!cancelled) {
          setBooks(result);
          setStale(false);
        }
      } catch {
        // Transient RPC failure: keep the previous snapshot, flag it stale;
        // the next poll recovers.
        if (!cancelled) {
          setStale(true);
        }
      }
    }

    void load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [program, keysJoined]);

  return { books, stale };
}
