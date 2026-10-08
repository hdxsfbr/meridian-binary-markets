"use client";

/**
 * Live view of the program's `Config` singleton: pause state, enabled
 * tickers, and the admin-override delay. Refreshes on a 15s interval and on
 * an `onAccountChange` subscription, whichever notices a change first.
 */

import { useContext, useEffect, useState } from "react";
import { bytesToHex, configPda, tickerFromBytes, type Ticker } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { accountClient, useProgram } from "./useProgram";
import { AppDataContext } from "./app-data-context";

export type ConfigSnapshot = {
  paused: boolean;
  /** Only the tickers with `TickerInfo.enabled == true`. */
  tickers: Ticker[];
  /** `TickerInfo.feed_id`, lowercase hex (no `0x`), keyed by ticker, for every enabled ticker. */
  feedIds: Partial<Record<Ticker, string>>;
  overrideDelaySecs: number;
  /** Which price source settles markets: the in-program mock or the Pyth receiver. */
  oracleProvider: "mock" | "pyth";
};

const REFRESH_INTERVAL_MS = 15_000;

type RawTickerInfo = { symbol: number[]; enabled: boolean; feedId: number[] };
type RawConfig = {
  paused: boolean;
  tickers: RawTickerInfo[];
  overrideDelaySecs: number | string;
  oracleProvider?: Record<string, unknown>;
};

function decodeConfig(raw: RawConfig): ConfigSnapshot {
  const tickers: Ticker[] = [];
  const feedIds: Partial<Record<Ticker, string>> = {};
  for (const info of raw.tickers) {
    if (info.enabled) {
      const ticker = tickerFromBytes(Uint8Array.from(info.symbol));
      tickers.push(ticker);
      feedIds[ticker] = bytesToHex(Uint8Array.from(info.feedId));
    }
  }
  return {
    paused: Boolean(raw.paused),
    tickers,
    feedIds,
    overrideDelaySecs: Number(raw.overrideDelaySecs),
    oracleProvider: raw.oracleProvider !== undefined && "pythReceiver" in raw.oracleProvider ? "pyth" : "mock",
  };
}

/**
 * The current `Config` snapshot, or `null` until the first fetch resolves.
 * Reads the shared snapshot from `AppDataProvider` when one is mounted
 * above the caller (the normal case: it wraps the whole app in
 * `layout.tsx`), so no extra poller/subscription is started; falls back to
 * polling itself (via `useConfigPolling`) only when no provider is present,
 * e.g. in an isolated test.
 */
export function useConfig(): ConfigSnapshot | null {
  const ctx = useContext(AppDataContext);
  const polled = useConfigPolling(ctx !== undefined);
  return ctx !== undefined ? ctx.config : polled;
}

/**
 * The actual polling implementation: fetches `Config` on a 15s interval and
 * an `onAccountChange` subscription. Exactly one instance of this should
 * run per app -- `AppDataProvider` is the only caller that should invoke
 * it directly; every other caller should use `useConfig` above, which reads
 * the provider's shared snapshot instead of starting its own poller.
 *
 * `skip` short-circuits the effect (no fetch, no subscription) once a
 * provider's own snapshot has taken over for `useConfig`'s fallback
 * instance, so switching from "no provider" to "provider mounted" across a
 * re-render can't leave two pollers running.
 */
export function useConfigPolling(skip = false): ConfigSnapshot | null {
  const program = useProgram();
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);

  useEffect(() => {
    if (skip) {
      return;
    }
    let cancelled = false;
    const [pda] = configPda(PROGRAM_ID);

    async function load() {
      try {
        const account = (await accountClient(program, "config").fetchNullable(pda)) as RawConfig | null;
        if (cancelled || account === null) {
          return;
        }
        setConfig(decodeConfig(account));
      } catch {
        // Transient RPC failure: keep the previous snapshot rather than
        // blanking the UI; the next interval tick or account-change event
        // will recover it.
      }
    }

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);

    const subscriptionId = program.provider.connection.onAccountChange(pda, (accountInfo: { data: Buffer }) => {
      try {
        const decoded = program.coder.accounts.decode("config", accountInfo.data) as RawConfig;
        if (!cancelled) {
          setConfig(decodeConfig(decoded));
        }
      } catch {
        // Ignore a decode failure on an intermediate/partial write; the
        // interval refresh above will recover.
      }
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      void program.provider.connection.removeAccountChangeListener(subscriptionId);
    };
  }, [program, skip]);

  return config;
}
