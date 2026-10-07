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
import { mergeStatus, settledByOverride, unsettledAfterClose, formatEt } from "@/lib/admin-view";
import { AdminMarketRow } from "@/components/AdminMarketRow";
import { addStrike, adminSettleOverride, pause, unpause } from "@/lib/admin-tx";

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

function oracleProviderName(value: Record<string, unknown> | undefined): string {
  if (!value) {
    return "unknown";
  }
  if ("mockPyth" in value) {
    return "Mock Pyth (devnet simulation)";
  }
  if ("pythReceiver" in value) {
    return "Pyth Receiver";
  }
  return "unknown";
}

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
      <div className="px-6 py-8">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="mt-4 text-black/70">Admin access requires the operator wallet.</p>
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
    <div className="px-6 py-8">
      <h1 className="text-2xl font-semibold">Admin</h1>

      {actionError ? <p className="mt-4 text-red-700">{actionError}</p> : null}
      {actionNotice ? <p className="mt-4 text-emerald-800">{actionNotice}</p> : null}

      <section className="mt-6 rounded border border-black/10 p-4">
        <h2 className="text-lg font-semibold">Config</h2>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-black/60">Paused</dt>
            <dd>{config?.paused ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt className="text-black/60">Oracle provider</dt>
            <dd>{oracleProviderName(adminConfig?.oracleProvider)}</dd>
          </div>
          <div>
            <dt className="text-black/60">Override delay</dt>
            <dd>{config ? `${config.overrideDelaySecs}s` : "—"}</dd>
          </div>
          <div>
            <dt className="text-black/60">Max staleness</dt>
            <dd>{adminConfig ? `${adminConfig.maxStalenessSecs}s` : "—"}</dd>
          </div>
          <div>
            <dt className="text-black/60">Max confidence (bps)</dt>
            <dd>{adminConfig ? String(adminConfig.maxConfBps) : "—"}</dd>
          </div>
          <div>
            <dt className="text-black/60">Min publish offset</dt>
            <dd>{adminConfig ? `${adminConfig.minPublishOffsetSecs}s` : "—"}</dd>
          </div>
        </dl>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={handlePause}
            disabled={busy !== null || config?.paused === true}
            className="rounded border border-black/20 px-3 py-1 disabled:opacity-50"
          >
            Pause
          </button>
          <button
            type="button"
            onClick={handleUnpause}
            disabled={busy !== null || config?.paused === false}
            className="rounded border border-black/20 px-3 py-1 disabled:opacity-50"
          >
            Unpause
          </button>
        </div>
      </section>

      <section className="mt-6 rounded border border-black/10 p-4">
        <h2 className="text-lg font-semibold">Add strike</h2>
        <form
          className="mt-2 flex flex-wrap items-end gap-3"
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
              className="rounded border border-black/20 px-2 py-1"
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
              className="w-32 rounded border border-black/20 px-2 py-1"
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
              className="w-24 rounded border border-black/20 px-2 py-1"
            />
          </label>
          <span className="text-sm text-black/60">
            Close: {formatEt(tickerMarketsToday[0] !== undefined ? Number(tickerMarketsToday[0].closeTs) : closeTsForDay(day))}
          </span>
          <button type="submit" disabled={busy !== null} className="rounded border border-black/20 px-3 py-1 disabled:opacity-50">
            Add strike
          </button>
        </form>
      </section>

      <section className="mt-6 rounded border border-black/10 p-4">
        <h2 className="text-lg font-semibold">Unsettled markets</h2>
        {mergedRows.length === 0 ? (
          <p className="mt-2 text-black/70">Nothing unsettled past close right now.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-black/10">
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
        )}
      </section>

      <section className="mt-6 rounded border border-black/10 p-4">
        <h2 className="text-lg font-semibold">Settled by override</h2>
        {settledOverrideRows.length === 0 ? (
          <p className="mt-2 text-black/70">None today.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {settledOverrideRows.map((row) => (
              <li key={row.pubkey} className="rounded-full border border-black/20 px-3 py-1 text-sm">
                {row.ticker} {formatStrike(row.strike)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
