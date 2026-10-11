import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { DateTime } from "luxon";
import type { Ticker } from "@meridian/sdk";
import {
  runReconcileJob,
  lastReconcile,
  __resetLastReconcile,
  type ReconcileChain,
  type ReconcileFinding,
} from "../src/jobs/reconcile";
import type { MarketRecord, MarketSnapshot } from "../src/chain";
import type { JobRegistrySnapshot } from "../src/job-registry";
import { ET_ZONE } from "../src/calendar";

const MICRO = 1_000_000n;

/** Tuesday 2026-10-13: a plain trading day (not a weekend, not in the static NYSE holiday list). */
const TRADING_DAY = 20261013;
/** Saturday 2026-10-17. */
const WEEKEND_DAY = 20261017;

/** Unix ms at `hh:mm` ET on `day` (`YYYYMMDD`). */
function etMillis(day: number, hour: number, minute: number): number {
  const s = String(day);
  return DateTime.fromObject(
    { year: Number(s.slice(0, 4)), month: Number(s.slice(4, 6)), day: Number(s.slice(6, 8)), hour, minute },
    { zone: ET_ZONE },
  ).toMillis();
}

function pubkeyFor(n: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = n;
  return new PublicKey(bytes);
}

interface MarketSpec {
  id?: number;
  ticker?: Ticker;
  tradingDay?: number;
  state?: "Open" | "Settled";
  outcome?: "Unset" | "Yes" | "No";
  closeTs?: number;
  /** Whole pairs (`pairs_outstanding`), not micro units. */
  pairs?: bigint;
  /** Micro units. */
  vault?: bigint;
  yesSupply?: bigint;
  noSupply?: bigint;
}

/** A scanned record plus the snapshot the fake chain will serve for it. */
function market(spec: MarketSpec = {}): { record: MarketRecord; snapshot: MarketSnapshot } {
  const publicKey = pubkeyFor(spec.id ?? 1);
  const pairs = spec.pairs ?? 5n;
  const state = spec.state ?? "Open";
  const account = {
    ticker: (spec.ticker ?? "META") as Ticker,
    strike: 680_000_000n,
    tradingDay: spec.tradingDay ?? TRADING_DAY,
    closeTs: spec.closeTs ?? Math.floor(etMillis(spec.tradingDay ?? TRADING_DAY, 16, 0) / 1000),
    state,
    outcome: spec.outcome ?? (state === "Settled" ? ("Yes" as const) : ("Unset" as const)),
    settlementPrice: 0n,
    settledAt: 0,
    settledByOverride: false,
    yesMint: pubkeyFor(100 + (spec.id ?? 1)),
    noMint: pubkeyFor(150 + (spec.id ?? 1)),
    vault: pubkeyFor(200 + (spec.id ?? 1)),
    book: pubkeyFor(250 + (spec.id ?? 1)),
    bookCapacity: 128,
    pairsOutstanding: pairs,
  };
  return {
    record: { publicKey, account },
    snapshot: {
      publicKey,
      account,
      vaultAmount: spec.vault ?? pairs * MICRO,
      yesSupply: spec.yesSupply ?? pairs * MICRO,
      noSupply: spec.noSupply ?? pairs * MICRO,
    },
  };
}

interface FakeEntry {
  record: MarketRecord;
  /** Served in order; the last one is reused for any further snapshot call. */
  snapshots: MarketSnapshot[];
  /** When set, every snapshot call for this market rejects with it. */
  snapshotError?: Error;
}

interface FakeChainOptions {
  entries?: FakeEntry[];
  tickers?: Array<{ symbol: Ticker; enabled: boolean }>;
  failOpenScan?: boolean;
  failSettledScan?: boolean;
  failConfig?: boolean;
}

class FakeChain implements ReconcileChain {
  readonly snapshotCalls = new Map<string, number>();

  constructor(private readonly opts: FakeChainOptions = {}) {}

  private get entries(): FakeEntry[] {
    return this.opts.entries ?? [];
  }

  async fetchOpenMarkets(): Promise<MarketRecord[]> {
    if (this.opts.failOpenScan) throw new Error("open scan boom");
    return this.entries.filter((e) => e.record.account.state === "Open").map((e) => e.record);
  }

  async fetchSettledMarkets(): Promise<MarketRecord[]> {
    if (this.opts.failSettledScan) throw new Error("settled scan boom");
    return this.entries.filter((e) => e.record.account.state === "Settled").map((e) => e.record);
  }

  async fetchConfig(): Promise<{ tickers: Array<{ symbol: Ticker; enabled: boolean }> }> {
    if (this.opts.failConfig) throw new Error("config boom");
    return { tickers: this.opts.tickers ?? [] };
  }

  async fetchMarketSnapshot(market: PublicKey): Promise<MarketSnapshot | null> {
    const key = market.toBase58();
    const calls = (this.snapshotCalls.get(key) ?? 0) + 1;
    this.snapshotCalls.set(key, calls);
    const entry = this.entries.find((e) => e.record.publicKey.toBase58() === key);
    if (!entry) return null;
    if (entry.snapshotError) throw entry.snapshotError;
    return entry.snapshots[Math.min(calls - 1, entry.snapshots.length - 1)];
  }
}

function entry(m: { record: MarketRecord; snapshot: MarketSnapshot }, extra: Partial<FakeEntry> = {}): FakeEntry {
  return { record: m.record, snapshots: [m.snapshot], ...extra };
}

/** A registry that makes every heartbeat non-judgeable (worker started "just now"). */
function freshRegistry(nowMs: number): () => JobRegistrySnapshot {
  return () => ({ workerStartedAt: nowMs, lastCompletedAt: {} });
}

interface RunResult {
  findings: ReconcileFinding[];
  alerts: Array<{ summary?: string; error: string }>;
  chain: FakeChain;
  counts: { checks: number; violations: number; warnings: number; checkFailed: number };
}

async function run(
  chainOpts: FakeChainOptions,
  nowMs: number,
  registry: () => JobRegistrySnapshot = freshRegistry(nowMs),
  alertFn?: (input: { summary?: string; error: string }) => Promise<void>,
): Promise<RunResult> {
  const chain = new FakeChain(chainOpts);
  const alerts: Array<{ summary?: string; error: string }> = [];
  const report = await runReconcileJob({
    chain,
    now: () => nowMs,
    registry,
    alertFn: async (input) => {
      alerts.push({ summary: input.summary, error: input.error });
      if (alertFn) await alertFn({ summary: input.summary, error: input.error });
    },
  });
  return { findings: report.findings, alerts, chain, counts: report.counts };
}

/** 10:00 ET on a trading day: mid-session, nothing overdue, ladder check active. */
const MID_SESSION = etMillis(TRADING_DAY, 10, 0);

beforeEach(() => {
  __resetLastReconcile();
  vi.restoreAllMocks();
});

describe("reconcile: open market backing", () => {
  it("reports nothing for a healthy open market (5 pairs: vault 5_000_000, supplies 5_000_000)", async () => {
    const m = market({ pairs: 5n, vault: 5_000_000n, yesSupply: 5_000_000n, noSupply: 5_000_000n });
    const { findings, alerts, counts } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toEqual([]);
    expect(alerts).toHaveLength(0);
    expect(counts.checks).toBeGreaterThan(0);
  });

  it("reports a vault deficit as a violation naming both amounts", async () => {
    const m = market({ pairs: 5n, vault: 4_000_000n });
    const { findings, alerts } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("VIOLATION");
    expect(findings[0].check).toBe("open_backing");
    expect(findings[0].detail).toContain("vault deficit");
    expect(findings[0].detail).toContain("vault=4000000");
    expect(findings[0].detail).toContain("pairsMicro=5000000");
    expect(alerts).toHaveLength(1);
  });

  it("reports a vault surplus as a warning, not a violation", async () => {
    const m = market({ pairs: 5n, vault: 6_000_000n });
    const { findings, counts } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("WARNING");
    expect(findings[0].detail).toContain("vault surplus");
    expect(counts.violations).toBe(0);
    expect(counts.warnings).toBe(1);
  });

  it("reports a supply mismatch as a violation naming all three numbers", async () => {
    const m = market({ pairs: 5n, vault: 5_000_000n, yesSupply: 5_000_000n, noSupply: 4_000_000n });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe("open_supply");
    expect(findings[0].severity).toBe("VIOLATION");
    expect(findings[0].detail).toContain("yesSupply=5000000");
    expect(findings[0].detail).toContain("noSupply=4000000");
    expect(findings[0].detail).toContain("pairsMicro=5000000");
  });

  it("compares whole pairs against micro units (a 5-pair market is not a 5-micro-unit market)", async () => {
    // The pre-rewrite bug: `pairsOutstanding` (5) compared directly against a 5_000_000 supply.
    const m = market({ pairs: 5n, vault: 5_000_000n });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toEqual([]);
  });
});

describe("reconcile: settled market backing", () => {
  it("reports nothing after a partial winner redemption (pairs 5, winning supply 2_000_000, vault 2_000_000)", async () => {
    const m = market({
      state: "Settled",
      outcome: "Yes",
      pairs: 5n,
      vault: 2_000_000n,
      yesSupply: 2_000_000n,
      noSupply: 0n,
    });
    const { findings, alerts } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toEqual([]);
    expect(alerts).toHaveLength(0);
  });

  it("reports a settled vault deficit against the winning supply as a violation", async () => {
    const m = market({
      state: "Settled",
      outcome: "Yes",
      pairs: 5n,
      vault: 1_000_000n,
      yesSupply: 2_000_000n,
      noSupply: 0n,
    });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe("settled_backing");
    expect(findings[0].severity).toBe("VIOLATION");
    expect(findings[0].detail).toContain("winningSupply=2000000");
  });

  it("warns on a settled surplus even when the losing side still holds tokens", async () => {
    // Losing tokens never explain collateral: `redeem_pair` burns one of each side per 1_000_000
    // paid and `redeem_winning` burns one winning token per 1_000_000 paid, so the vault always
    // moves together with the winning supply. Winners all redeemed (yesSupply 0) while 3 No tokens
    // remain: a 3_000_000 vault is unsolicited money, and it must stay visible.
    const m = market({
      state: "Settled",
      outcome: "Yes",
      pairs: 5n,
      vault: 3_000_000n,
      yesSupply: 0n,
      noSupply: 3_000_000n,
    });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("WARNING");
    expect(findings[0].detail).toContain("vault surplus: vault=3000000 > winningSupply=0");
  });

  it("warns on a settled surplus that neither side's supply explains", async () => {
    const m = market({
      state: "Settled",
      outcome: "Yes",
      pairs: 5n,
      vault: 4_000_000n,
      yesSupply: 2_000_000n,
      noSupply: 3_000_000n,
    });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("WARNING");
    expect(findings[0].detail).toContain("vault surplus");
  });

  it("reports a settled supply above pairsMicro as a violation", async () => {
    const m = market({
      state: "Settled",
      outcome: "Yes",
      pairs: 2n,
      vault: 2_000_000n,
      yesSupply: 2_000_000n,
      noSupply: 3_000_000n,
    });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    const supply = findings.filter((f) => f.check === "settled_supply");
    expect(supply).toHaveLength(1);
    expect(supply[0].severity).toBe("VIOLATION");
    expect(supply[0].detail).toContain("supply above pairs");
  });
});

describe("reconcile: overdue settlement", () => {
  it("does not flag an open market 14 minutes past close", async () => {
    const closeTs = Math.floor(MID_SESSION / 1000) - 14 * 60;
    const m = market({ closeTs });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toEqual([]);
  });

  it("flags an open market 16 minutes past close, with the minutes overdue", async () => {
    const closeTs = Math.floor(MID_SESSION / 1000) - 16 * 60;
    const m = market({ closeTs });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe("settlement_overdue");
    expect(findings[0].severity).toBe("VIOLATION");
    expect(findings[0].detail).toContain("16 min past close");
  });
});

describe("reconcile: today's ladder", () => {
  const tickers: Array<{ symbol: Ticker; enabled: boolean }> = [
    { symbol: "META" as Ticker, enabled: true },
    { symbol: "NVDA" as Ticker, enabled: false },
  ];

  it("accepts today's ladder when the day's markets are already settled (evening pass)", async () => {
    const m = market({
      id: 2,
      ticker: "META" as Ticker,
      state: "Settled",
      outcome: "No",
      pairs: 0n,
      vault: 0n,
      yesSupply: 0n,
      noSupply: 0n,
    });
    const after16 = etMillis(TRADING_DAY, 18, 0);
    const { findings } = await run({ entries: [entry(m)], tickers }, after16, freshRegistry(after16));
    expect(findings).toEqual([]);
  });

  it("flags an enabled ticker with no market for today on a trading day", async () => {
    const { findings } = await run({ entries: [], tickers }, MID_SESSION);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe("ladder");
    expect(findings[0].severity).toBe("VIOLATION");
    expect(findings[0].ticker).toBe("META");
  });

  it("is not checked on a weekend", async () => {
    const saturday = etMillis(WEEKEND_DAY, 10, 0);
    const { findings } = await run({ entries: [], tickers }, saturday, freshRegistry(saturday));
    expect(findings).toEqual([]);
  });

  it("is not checked before 08:30 ET", async () => {
    const early = etMillis(TRADING_DAY, 8, 15);
    const { findings } = await run({ entries: [], tickers }, early, freshRegistry(early));
    expect(findings).toEqual([]);
  });
});

describe("reconcile: heartbeats", () => {
  it("flags a scheduled job whose last completion predates its most recent due run", async () => {
    const registry = (): JobRegistrySnapshot => ({
      workerStartedAt: etMillis(TRADING_DAY, 7, 0),
      lastCompletedAt: {},
    });
    const { findings } = await run({ entries: [] }, MID_SESSION, registry);
    const jobs = findings.filter((f) => f.check === "heartbeat").map((f) => f.job);
    // At 10:00 ET, `morning` (08:00) and the `extend` tick at 09:50 are both past their grace;
    // `settle` (16:00:30) and `reclaim` (20:00) are not due yet.
    expect(jobs.sort()).toEqual(["extend", "morning"]);
    expect(findings.every((f) => f.severity === "VIOLATION")).toBe(true);
    expect(findings[0].detail).toContain("job did not run");
  });

  it("does not flag a job that completed after its most recent due run", async () => {
    const registry = (): JobRegistrySnapshot => ({
      workerStartedAt: etMillis(TRADING_DAY, 7, 0),
      lastCompletedAt: {
        morning: etMillis(TRADING_DAY, 8, 1),
        extend: etMillis(TRADING_DAY, 9, 51),
      },
    });
    const { findings } = await run({ entries: [] }, MID_SESSION, registry);
    expect(findings).toEqual([]);
  });

  it("is not checked on a weekend", async () => {
    const saturday = etMillis(WEEKEND_DAY, 12, 0);
    const registry = (): JobRegistrySnapshot => ({
      workerStartedAt: etMillis(WEEKEND_DAY, 0, 1),
      lastCompletedAt: {},
    });
    const { findings } = await run({ entries: [] }, saturday, registry);
    expect(findings).toEqual([]);
  });
});

describe("reconcile: pass robustness", () => {
  it("records a per-market read failure as CHECK_FAILED, keeps checking the others, and still alerts", async () => {
    const broken = market({ id: 3, ticker: "META" as Ticker });
    const healthy = market({ id: 4, ticker: "NVDA" as Ticker, pairs: 2n });
    const chain = new FakeChain({
      entries: [entry(broken, { snapshotError: new Error("rpc timeout") }), entry(healthy)],
    });
    const alerts: string[] = [];
    const report = await runReconcileJob({
      chain,
      now: () => MID_SESSION,
      registry: freshRegistry(MID_SESSION),
      alertFn: async (input) => {
        alerts.push(input.error);
      },
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].severity).toBe("CHECK_FAILED");
    expect(report.findings[0].detail).toContain("rpc timeout");
    expect(report.counts.checkFailed).toBe(1);
    // The healthy market was still snapshotted and checked after the failure.
    expect(chain.snapshotCalls.get(healthy.record.publicKey.toBase58())).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("CHECK_FAILED");
  });

  it("does not report a transient deficit that is gone on the re-snapshot", async () => {
    const m = market({ pairs: 5n, vault: 5_000_000n });
    const transient: MarketSnapshot = { ...m.snapshot, vaultAmount: 4_000_000n };
    const chain = new FakeChain({ entries: [{ record: m.record, snapshots: [transient, m.snapshot] }] });
    const alerts: string[] = [];
    const report = await runReconcileJob({
      chain,
      now: () => MID_SESSION,
      registry: freshRegistry(MID_SESSION),
      alertFn: async (input) => {
        alerts.push(input.error);
      },
    });
    expect(report.findings).toEqual([]);
    expect(alerts).toHaveLength(0);
    expect(chain.snapshotCalls.get(m.record.publicKey.toBase58())).toBe(2);
  });

  it("sends exactly one alert for a pass with several findings", async () => {
    const a = market({ id: 5, ticker: "META" as Ticker, pairs: 5n, vault: 4_000_000n });
    const b = market({ id: 6, ticker: "NVDA" as Ticker, pairs: 5n, vault: 6_000_000n });
    const { alerts, findings } = await run({ entries: [entry(a), entry(b)] }, MID_SESSION);
    expect(findings).toHaveLength(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toContain("1 violation(s), 1 warning(s)");
    expect(alerts[0].error).toContain("market=");
  });

  it("completes the pass and stores the report even when alertFn throws", async () => {
    const m = market({ pairs: 5n, vault: 4_000_000n });
    const chain = new FakeChain({ entries: [entry(m)] });
    const report = await runReconcileJob({
      chain,
      now: () => MID_SESSION,
      registry: freshRegistry(MID_SESSION),
      alertFn: async () => {
        throw new Error("webhook down");
      },
    });
    expect(report.counts.violations).toBe(1);
    expect(lastReconcile).toEqual(report);
  });

  it("records a failed market scan as CHECK_FAILED and skips the ladder check rather than guessing", async () => {
    const { findings } = await run(
      { failOpenScan: true, tickers: [{ symbol: "META" as Ticker, enabled: true }] },
      MID_SESSION,
    );
    expect(findings.map((f) => f.check).sort()).toEqual(["ladder", "scan_open"]);
    expect(findings.every((f) => f.severity === "CHECK_FAILED")).toBe(true);
  });

  it("exports the report for /status", async () => {
    const m = market({ pairs: 1n });
    const { findings } = await run({ entries: [entry(m)] }, MID_SESSION);
    expect(findings).toEqual([]);
    expect(lastReconcile?.tradingDay).toBe(TRADING_DAY);
    expect(lastReconcile?.ranAt).toBe(new Date(MID_SESSION).toISOString());
  });
});
