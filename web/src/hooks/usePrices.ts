"use client";

/**
 * Latest observed price per ticker. Reads `MockPriceUpdate` today; the
 * interface is provider-agnostic on purpose (data-model.md: `OracleQuote`
 * is the common shape both a mock and a future Pyth source produce), so a
 * later Pyth-backed source can fill the same `TickerPrice` shape without
 * this hook's callers changing. No provider name is ever surfaced in UI
 * copy — the product calls this "Last price".
 */

import { useEffect, useState } from "react";
import { feedIdBytes, mockPricePda, TICKERS, type Ticker } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { accountClient, useProgram } from "./useProgram";
import { useConfig } from "./useConfig";

export type TickerPrice = {
  /** Last observed price, normalised to micro-USD (6 decimals). */
  priceMicro: bigint;
  /** Unix seconds the price was published. */
  publishTime: number;
};

const REFRESH_INTERVAL_MS = 15_000;

type BnLike = { toString(): string };
type RawPriceUpdate = { price: BnLike; expo: number; publishTime: BnLike };

/** Normalises `price * 10^expo` to micro-USD (`price * 10^(expo + 6)`), bigint throughout. */
function scaleToMicroUsd(price: bigint, expo: number): bigint {
  const shift = expo + 6;
  if (shift >= 0) {
    return price * 10n ** BigInt(shift);
  }
  return price / 10n ** BigInt(-shift);
}

function decodePrice(raw: RawPriceUpdate): TickerPrice {
  return {
    priceMicro: scaleToMicroUsd(BigInt(raw.price.toString()), Number(raw.expo)),
    publishTime: Number(raw.publishTime.toString()),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The feed id bytes for `ticker`: the live on-chain `Config` value when present, else the SDK constant. */
function feedIdBytesFor(ticker: Ticker, feedIds: Partial<Record<Ticker, string>>): Uint8Array {
  const hex = feedIds[ticker];
  return hex !== undefined ? hexToBytes(hex) : feedIdBytes(ticker);
}

/** Latest price per ticker, keyed by `Ticker`; absent until the first successful fetch for that ticker. */
export function usePrices(): Partial<Record<Ticker, TickerPrice>> {
  const program = useProgram();
  const config = useConfig();
  const feedIds = config?.feedIds ?? {};
  const [prices, setPrices] = useState<Partial<Record<Ticker, TickerPrice>>>({});

  useEffect(() => {
    let cancelled = false;
    const targets = TICKERS.map((ticker) => ({
      ticker,
      pda: mockPricePda(PROGRAM_ID, feedIdBytesFor(ticker, feedIds))[0],
    }));

    async function load() {
      const results = await Promise.all(
        targets.map(async ({ ticker, pda }) => {
          try {
            const account = (await accountClient(program, "mockPriceUpdate").fetchNullable(
              pda,
            )) as RawPriceUpdate | null;
            return { ticker, account };
          } catch {
            return { ticker, account: null };
          }
        }),
      );
      if (cancelled) {
        return;
      }
      setPrices((prev) => {
        const next = { ...prev };
        for (const { ticker, account } of results) {
          if (account !== null) {
            next[ticker] = decodePrice(account);
          }
        }
        return next;
      });
    }

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);

    const subscriptionIds = targets.map(({ ticker, pda }) =>
      program.provider.connection.onAccountChange(pda, (accountInfo: { data: Buffer }) => {
        try {
          const raw = program.coder.accounts.decode("mockPriceUpdate", accountInfo.data) as RawPriceUpdate;
          if (!cancelled) {
            setPrices((prev) => ({ ...prev, [ticker]: decodePrice(raw) }));
          }
        } catch {
          // Transient/partial write; the interval refresh above recovers.
        }
      }),
    );

    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const id of subscriptionIds) {
        void program.provider.connection.removeAccountChangeListener(id);
      }
    };
    // `feedIdsKey` (not `feedIds` itself, a new object every config poll)
    // is the real dependency: only re-subscribe when a feed id actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, JSON.stringify(feedIds)]);

  return prices;
}
