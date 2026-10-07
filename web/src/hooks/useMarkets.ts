"use client";

/**
 * Today's (or a given trading day's) `Market` accounts, decoded with
 * `bigint` money fields and live-updated via `onProgramAccountChange`.
 * `useBook` (per-market order book) is Wave 5.
 */

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { GetProgramAccountsFilter } from "@solana/web3.js";
import { tickerFromBytes, type Ticker } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { todayTradingDay } from "@/lib/markets";
import { accountClient, useProgram } from "./useProgram";

export type MarketLifecycleState = "open" | "settled";
export type MarketOutcome = "unset" | "yes" | "no";

export type MarketAccount = {
  pubkey: PublicKey;
  ticker: Ticker;
  /** Micro-USD. */
  strike: bigint;
  /** `YYYYMMDD`. */
  tradingDay: number;
  /** Unix seconds, 16:00 ET of `tradingDay`. */
  closeTs: bigint;
  state: MarketLifecycleState;
  outcome: MarketOutcome;
  /** Micro-USD; 0 until settled. */
  settlementPrice: bigint;
  /** Unix seconds; 0 until settled. */
  settledAt: bigint;
  settledByOverride: boolean;
  bookCapacity: number;
  pairsOutstanding: bigint;
};

/**
 * Byte offset of `Market.trading_day` (u32) in account data: 8-byte
 * discriminator + `ticker: [u8; 8]` + `strike: u64` (data-model.md), matching
 * the on-chain struct's declared field order.
 */
const TRADING_DAY_OFFSET = 8 + 8 + 8;

type BnLike = { toString(): string };
type EnumValue = Record<string, unknown>;
type RawMarket = {
  ticker: number[];
  strike: BnLike;
  tradingDay: number;
  closeTs: BnLike;
  state: EnumValue;
  outcome: EnumValue;
  settlementPrice: BnLike;
  settledAt: BnLike;
  settledByOverride: boolean;
  bookCapacity: number;
  pairsOutstanding: BnLike;
};

function enumKey(value: EnumValue): string {
  return Object.keys(value)[0] ?? "";
}

function toBigInt(value: BnLike): bigint {
  return BigInt(value.toString());
}

function decodeMarket(pubkey: PublicKey, raw: RawMarket): MarketAccount {
  return {
    pubkey,
    ticker: tickerFromBytes(Uint8Array.from(raw.ticker)),
    strike: toBigInt(raw.strike),
    tradingDay: Number(raw.tradingDay),
    closeTs: toBigInt(raw.closeTs),
    state: enumKey(raw.state) as MarketLifecycleState,
    outcome: enumKey(raw.outcome) as MarketOutcome,
    settlementPrice: toBigInt(raw.settlementPrice),
    settledAt: toBigInt(raw.settledAt),
    settledByOverride: Boolean(raw.settledByOverride),
    bookCapacity: Number(raw.bookCapacity),
    pairsOutstanding: toBigInt(raw.pairsOutstanding),
  };
}

function u32LEBytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Minimal base64 encoder with no `Buffer`/global dependency (browser-safe). */
function toBase64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    result += BASE64_CHARS[(triplet >> 18) & 0x3f];
    result += BASE64_CHARS[(triplet >> 12) & 0x3f];
    result += b1 !== undefined ? BASE64_CHARS[(triplet >> 6) & 0x3f] : "=";
    result += b2 !== undefined ? BASE64_CHARS[triplet & 0x3f] : "=";
  }
  return result;
}

function tradingDayFilters(day: number): GetProgramAccountsFilter[] {
  return [
    {
      memcmp: {
        offset: TRADING_DAY_OFFSET,
        bytes: toBase64(u32LEBytes(day)),
        encoding: "base64",
      },
    },
  ];
}

export type UseMarketsResult = {
  markets: MarketAccount[];
  /** True until the first fetch attempt (success or final failure) resolves. */
  loading: boolean;
  /** True while every retry for the current fetch attempt has failed. */
  error: boolean;
};

const REFRESH_INTERVAL_MS = 30_000;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 1_000;

/**
 * `Market` accounts for `tradingDay` (today's, by default), server-filtered
 * via `memcmp` on `trading_day`'s computed byte offset and re-checked
 * client-side in case that offset ever drifts from the on-chain layout.
 *
 * Refreshes every 30s. A failed fetch is retried with exponential backoff
 * (up to `MAX_RETRIES`) before `error` is surfaced; `loading` stays true
 * until the first attempt (success or exhausted retries) resolves, so the
 * page can distinguish "loading" from "failed to load" from "no contracts
 * yet" (an empty, successful result).
 */
export function useMarkets(tradingDay?: number): UseMarketsResult {
  const program = useProgram();
  const day = tradingDay ?? todayTradingDay();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const filters = tradingDayFilters(day);

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function fetchOnce(): Promise<MarketAccount[]> {
      const accounts = (await accountClient(program, "market").all(filters)) as Array<{
        publicKey: PublicKey;
        account: RawMarket;
      }>;
      return accounts.map(({ publicKey, account }) => decodeMarket(publicKey, account)).filter((m) => m.tradingDay === day);
    }

    async function loadWithRetry() {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          const decoded = await fetchOnce();
          if (cancelled) {
            return;
          }
          setMarkets(decoded);
          setError(false);
          setLoading(false);
          return;
        } catch {
          if (cancelled) {
            return;
          }
          if (attempt === MAX_RETRIES) {
            // Retries exhausted: surface the failure, but keep the previous
            // snapshot rather than blanking the UI; the next 30s refresh
            // tries again from attempt 0.
            setError(true);
            setLoading(false);
            return;
          }
          await sleep(RETRY_BASE_MS * 2 ** attempt);
        }
      }
    }

    async function scheduleRefresh() {
      if (cancelled) {
        return;
      }
      await loadWithRetry();
      if (cancelled) {
        return;
      }
      refreshTimer = setTimeout(scheduleRefresh, REFRESH_INTERVAL_MS);
    }

    setLoading(true);
    void scheduleRefresh();

    const subscriptionId = program.provider.connection.onProgramAccountChange(
      PROGRAM_ID,
      (keyedAccountInfo: { accountId: PublicKey; accountInfo: { data: Buffer } }) => {
        try {
          const raw = program.coder.accounts.decode("market", keyedAccountInfo.accountInfo.data) as RawMarket;
          const decoded = decodeMarket(keyedAccountInfo.accountId, raw);
          if (cancelled || decoded.tradingDay !== day) {
            return;
          }
          setMarkets((prev) => {
            const next = prev.filter((m) => !m.pubkey.equals(decoded.pubkey));
            next.push(decoded);
            return next;
          });
        } catch {
          // Not a `Market` account (discriminator mismatch) or a transient
          // partial write; ignore.
        }
      },
      "confirmed",
      filters,
    );

    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
      }
      void program.provider.connection.removeProgramAccountChangeListener(subscriptionId);
    };
  }, [program, day]);

  return { markets, loading, error };
}
