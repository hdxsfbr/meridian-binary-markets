"use client";

/**
 * Live view of the program's `Config` singleton: pause state, enabled
 * tickers, and the admin-override delay. Refreshes on a 15s interval and on
 * an `onAccountChange` subscription, whichever notices a change first.
 */

import { useEffect, useState } from "react";
import { bytesToHex, configPda, tickerFromBytes, type Ticker } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { accountClient, useProgram } from "./useProgram";

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

/** The current `Config` snapshot, or `null` until the first fetch resolves. */
export function useConfig(): ConfigSnapshot | null {
  const program = useProgram();
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);

  useEffect(() => {
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
  }, [program]);

  return config;
}
