"use client";

/**
 * Latest observed price per ticker. Reads `MockPriceUpdate` today; the
 * interface is provider-agnostic on purpose (data-model.md: `OracleQuote`
 * is the common shape both a mock and a future Pyth source produce), so a
 * later Pyth-backed source can fill the same `TickerPrice` shape without
 * this hook's callers changing. No provider name is ever surfaced in UI
 * copy — the product calls this "Last price".
 */

import { useContext, useEffect, useState } from "react";
import { feedIdBytes, mockPricePda, TICKERS, type Ticker } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { accountClient, useProgram } from "./useProgram";
import { useConfig, type ConfigSnapshot } from "./useConfig";
import { AppDataContext } from "./app-data-context";

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

/**
 * Latest price per ticker, keyed by `Ticker`; absent until the first
 * successful fetch for that ticker. Reads the shared snapshot from
 * `AppDataProvider` when one is mounted above the caller, so no extra
 * poller is started; falls back to polling itself (via `usePricesPolling`)
 * only when no provider is present, e.g. in an isolated test.
 */
export function usePrices(): Partial<Record<Ticker, TickerPrice>> {
  const ctx = useContext(AppDataContext);
  const config = useConfig();
  const polled = usePricesPolling(config, ctx !== undefined);
  return ctx !== undefined ? ctx.prices : polled;
}

/**
 * The actual polling implementation, parameterised on the already-fetched
 * `Config` snapshot rather than calling `useConfig` itself, so
 * `AppDataProvider` can share one `Config` poll between this hook and
 * `useConfig`'s callers instead of each hook fetching `Config` on its own.
 * Exactly one instance of this should run per app -- `AppDataProvider` is
 * the only caller that should invoke it directly; every other caller
 * should use `usePrices` above.
 *
 * `skip` short-circuits both effects once a provider's own snapshot has
 * taken over for `usePrices`'s fallback instance.
 */
export function usePricesPolling(config: ConfigSnapshot | null, skip = false): Partial<Record<Ticker, TickerPrice>> {
  const program = useProgram();
  const feedIds = config?.feedIds ?? {};
  const [prices, setPrices] = useState<Partial<Record<Ticker, TickerPrice>>>({});

  const oracleProvider = config?.oracleProvider ?? "mock";

  // Pyth provider: prices are not on chain between settlements, so poll the
  // app's own `/api/prices` proxy (server-side key) for the enabled feeds.
  useEffect(() => {
    if (skip || oracleProvider !== "pyth") return;
    let cancelled = false;
    const tickers = config?.tickers ?? [];
    const idByTicker = new Map<Ticker, string>();
    for (const ticker of tickers) {
      const hex = feedIds[ticker];
      if (hex !== undefined) idByTicker.set(ticker, hex.toLowerCase());
    }
    if (idByTicker.size === 0) return;

    async function load() {
      try {
        const response = await fetch(`/api/prices?ids=${[...idByTicker.values()].join(",")}`, { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as Record<string, { priceMicro: string; publishTime: number }>;
        if (cancelled) return;
        setPrices((prev) => {
          const next = { ...prev };
          for (const [ticker, id] of idByTicker) {
            const entry = body[id];
            if (entry !== undefined) {
              next[ticker] = { priceMicro: BigInt(entry.priceMicro), publishTime: entry.publishTime };
            }
          }
          return next;
        });
      } catch {
        // Keep the last prices; the interval retries.
      }
    }
    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, oracleProvider, JSON.stringify(feedIds)]);

  useEffect(() => {
    if (skip || oracleProvider === "pyth") return;
    let cancelled = false;
    const targets = (config?.tickers ?? TICKERS).map((ticker) => ({
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
  }, [skip, program, JSON.stringify(feedIds)]);

  return prices;
}
