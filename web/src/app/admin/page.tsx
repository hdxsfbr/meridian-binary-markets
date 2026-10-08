"use client";

/**
 * `/admin` (T074): operator diagnostics, not linked from product navigation
 * (contracts/frontend.md). Gated on the connected wallet matching
 * `Config.admin` — every other page works without a wallet, but this one
 * refuses outright rather than letting a non-operator see even the config
 * summary.
 */

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSendTransaction } from "../../lib/wallet-send";
import { PublicKey } from "@solana/web3.js";
import { configPda, TICKERS, type Ticker } from "@meridian/sdk";
import { PROGRAM_ID } from "@/lib/rpc";
import { accountClient, useProgram } from "@/hooks/useProgram";
import { useConfig } from "@/hooks/useConfig";
import { useAllMarkets, useMarkets } from "@/hooks/useMarkets";
import { useStatus } from "@/hooks/useStatus";
import { closeTsForDay, todayTradingDay } from "@/lib/markets";
import { formatStrike } from "@/lib/format";
import {
  confidenceLabel,
  mergeStatus,
  oracleProviderLabel,
  overrideDelayLabel,
  publishOffsetLabel,
  settledByOverride,
  stalenessLabel,
  unsettledAfterClose,
  formatEt,
} from "@/lib/admin-view";
import { AdminMarketRow } from "@/components/AdminMarketRow";
import { addStrike, adminSettleOverride, pause, unpause } from "@/lib/admin-tx";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineError } from "@/components/ui/InlineError";

const ONE_USDC = 1_000_000n;

/** Converts a dollar-string input (e.g. "680.50") to micro-USD, or `null` if invalid. */
function dollarsToMicro(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "" || !/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.padEnd(6, "0");
  return BigInt(whole) * ONE_USDC + BigInt(paddedFraction === "" ? "0" : paddedFraction);
}

type RawConfigFull = {
  admin: PublicKey;
  usdcMint: PublicKey;
  oracleProvider: Record<string, unknown>;
  maxStalenessSecs: number | string;
  maxConfBps: number | string;
  minPublishOffsetSecs: number | string;
};

/** The admin-only fields `useConfig`'s `ConfigSnapshot` does not expose. */
function useAdminConfig(): RawConfigFull | null {
  const program = useProgram();
  const [raw, setRaw] = useState<RawConfigFull | null>(null);

  useEffect(() => {
    let cancelled = false;
    const [pda] = configPda(PROGRAM_ID);

    async function load() {
      try {
        const account = (await accountClient(program, "config").fetchNullable(pda)) as RawConfigFull | null;
        if (!cancelled && account !== null) {
          setRaw(account);
        }
      } catch {
        // Transient RPC failure: keep the previous snapshot.
      }
    }

    load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [program]);

  return raw;
}

export default function AdminPage() {
  const { publicKey, connected } = useWallet();
  const sendTransaction = useSendTransaction();
  const { connection } = useConnection();
  const program = useProgram();
  const config = useConfig();
  const adminConfig = useAdminConfig();
  const day = todayTradingDay();
  const { markets } = useMarkets(day);
  // Today's close default (`tickerMarketsToday`) only needs today's markets;
  // "Unsettled markets" and "Settled by override" below must see every
  // trading day, so a market that closed yesterday and never settled is
  // never silently dropped once the day rolls over (item 11).
  const { markets: allMarkets } = useAllMarkets();
  const { status, unavailable: statusUnavailable } = useStatus();

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(interval);
  }, []);

  const [selectedTicker, setSelectedTicker] = useState<Ticker>(TICKERS[0]);
  const [strikeInput, setStrikeInput] = useState("");
  const [capacityInput, setCapacityInput] = useState("16");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const isAdmin = connected && publicKey !== null && adminConfig !== null && publicKey.equals(adminConfig.admin);

  const unsettled = useMemo(
    () =>
      unsettledAfterClose(
        allMarkets.map((m) => ({ pubkey: m.pubkey.toBase58(), ticker: m.ticker, strike: m.strike, closeTs: Number(m.closeTs), state: m.state })),
        now,
      ),
    [allMarkets, now],
  );
  const mergedRows = useMemo(() => mergeStatus(unsettled, status), [unsettled, status]);

  const settledOverrideRows = useMemo(
    () =>
      settledByOverride(
        allMarkets.map((m) => ({
          pubkey: m.pubkey.toBase58(),
          ticker: m.ticker,
          strike: m.strike,
          state: m.state,
          settledByOverride: m.settledByOverride,
        })),
      ),
    [allMarkets],
  );

  const tickerMarketsToday = useMemo(() => markets.filter((m) => m.ticker === selectedTicker), [markets, selectedTicker]);

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-[1440px] px-6 py-4">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <div className="mt-4">
          <EmptyState>Admin access requires the operator wallet.</EmptyState>
        </div>
      </div>
    );
  }

  const admin = publicKey as PublicKey;

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setActionError(null);
    setActionNotice(null);
    try {
      await action();
    } catch (error) {
      console.error("[meridian] admin action failed", error);
      setActionError("That action did not go through. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handlePause() {
    await run("pause", async () => {
      const result = await pause(program, connection, sendTransaction, admin);
      if (!result.ok) {
        setActionError(result.error);
      }
    });
  }

  async function handleUnpause() {
    await run("unpause", async () => {
      const result = await unpause(program, connection, sendTransaction, admin);
      if (!result.ok) {
        setActionError(result.error);
      }
    });
  }

  async function handleAddStrike() {
    await run("addStrike", async () => {
      const strikeMicro = dollarsToMicro(strikeInput);
      const capacity = Number(capacityInput);
      if (strikeMicro === null || strikeMicro <= 0n) {
        setActionError("Enter a strike greater than $0.");
        return;
      }
      if (!Number.isInteger(capacity) || capacity <= 0) {
        setActionError("Enter a capacity greater than 0.");
        return;
      }
      const closeTs = tickerMarketsToday[0] !== undefined ? Number(tickerMarketsToday[0].closeTs) : closeTsForDay(day);
      const result = await addStrike(
        program,
        connection,
        sendTransaction,
        admin,
        adminConfig?.usdcMint ?? admin,
        { ticker: selectedTicker, strike: strikeMicro, tradingDay: day, closeTs, capacity },
        tickerMarketsToday.length === 0,
      );
      if (!result.ok) {
        setActionError(result.error);
      } else {
        setStrikeInput("");
        setActionNotice(`Added ${selectedTicker} ${formatStrike(strikeMicro)}.`);
      }
    });
  }

  async function handleOverride(marketPubkey: string, priceDollars: string) {
    await run(`override:${marketPubkey}`, async () => {
      const priceMicro = dollarsToMicro(priceDollars);
      if (priceMicro === null || priceMicro <= 0n) {
        setActionError("Enter a settlement price greater than $0.");
        return;
      }
      const result = await adminSettleOverride(program, connection, sendTransaction, admin, new PublicKey(marketPubkey), priceMicro);
      if (!result.ok) {
        setActionError(result.error);
      }
    });
  }

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-6 py-4">
      <h1 className="text-2xl font-semibold">Admin</h1>

      {actionError ? <InlineError>{actionError}</InlineError> : null}
      {actionNotice ? <p className="text-success">{actionNotice}</p> : null}

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-lg font-semibold">Config</h2>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-text-muted">Paused</dt>
            <dd>{config?.paused ? "Yes" : "No"}</dd>
          </div>
        </dl>
        <p className="text-sm">{oracleProviderLabel(adminConfig?.oracleProvider)}</p>

        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Settlement checks</summary>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-text-muted">
            <li>{adminConfig ? stalenessLabel(Number(adminConfig.maxStalenessSecs)) : "—"}</li>
            <li>{adminConfig ? confidenceLabel(Number(adminConfig.maxConfBps)) : "—"}</li>
            <li>{adminConfig ? publishOffsetLabel(Number(adminConfig.minPublishOffsetSecs)) : "—"}</li>
            <li>{config ? overrideDelayLabel(config.overrideDelaySecs) : "—"}</li>
          </ul>
        </details>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handlePause}
            disabled={busy !== null || config?.paused === true}
            className="min-h-10 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Pause
          </button>
          <button
            type="button"
            onClick={handleUnpause}
            disabled={busy !== null || config?.paused === false}
            className="min-h-10 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Unpause
          </button>
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-lg font-semibold">Add strike</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAddStrike();
          }}
        >
          <label className="flex flex-col text-sm">
            Ticker
            <select
              value={selectedTicker}
              onChange={(e) => setSelectedTicker(e.target.value as Ticker)}
              className="min-h-10 rounded-md border border-border px-2 py-1"
            >
              {(config?.tickers ?? TICKERS).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            Strike ($)
            <input
              type="number"
              step="0.01"
              min="0"
              value={strikeInput}
              onChange={(e) => setStrikeInput(e.target.value)}
              className="min-h-10 w-32 rounded-md border border-border px-2 py-1"
            />
          </label>
          <label className="flex flex-col text-sm">
            Capacity
            <input
              type="number"
              step="1"
              min="1"
              value={capacityInput}
              onChange={(e) => setCapacityInput(e.target.value)}
              className="min-h-10 w-24 rounded-md border border-border px-2 py-1"
            />
          </label>
          <span className="py-2 text-sm text-text-muted">
            Close: {formatEt(tickerMarketsToday[0] !== undefined ? Number(tickerMarketsToday[0].closeTs) : closeTsForDay(day))}
          </span>
          <button
            type="submit"
            disabled={busy !== null}
            className="min-h-10 rounded-md bg-indigo px-4 py-2 text-sm font-medium text-on-brand disabled:opacity-60"
          >
            Add strike
          </button>
        </form>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-lg font-semibold">Unsettled markets</h2>
        {mergedRows.length === 0 ? (
          <EmptyState>Nothing unsettled past close right now.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 pr-4">Ticker</th>
                  <th className="py-2 pr-4">Strike</th>
                  <th className="py-2 pr-4">Closed since</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Override</th>
                </tr>
              </thead>
              <tbody>
                {mergedRows.map((row) => (
                  <AdminMarketRow
                    key={row.pubkey}
                    row={row}
                    overrideDelaySecs={config?.overrideDelaySecs ?? 3600}
                    now={now}
                    statusUnavailable={statusUnavailable}
                    submitting={busy === `override:${row.pubkey}`}
                    onOverride={(priceDollars) => handleOverride(row.pubkey, priceDollars)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-lg font-semibold">Settled by override</h2>
        {settledOverrideRows.length === 0 ? (
          <EmptyState>None today.</EmptyState>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {settledOverrideRows.map((row) => (
              <li key={row.pubkey} className="rounded-full border border-border px-3 py-1 text-sm">
                {row.ticker} {formatStrike(row.strike)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
