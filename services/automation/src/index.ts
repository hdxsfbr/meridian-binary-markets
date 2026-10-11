/**
 * Automation service entry point (contracts/automation.md, tasks.md T046).
 *
 * Three modes:
 *   `job <morning|settle|publisher|reclaim|extend|reconcile> [flags]` -- runs one job to
 *      completion and exits. The CLI entry points contract (contracts/automation.md).
 *      `job extend --once [--force]` runs a single ladder-extension tick now
 *      (DECISIONS.md §27); `--force` bypasses the 09:35-15:45 ET window/trading-day
 *      gate, for manual testing on devnet outside that window.
 *   `start` -- registers the cron schedule (America/New_York) for morning
 *      (08:00), settle (16:00:30), publisher (kicked off at 09:25, runs its
 *      own internal 60 s loop until the window closes), extend (every 5 minutes,
 *      gated to 09:35-15:45 ET inside the tick, DECISIONS.md §27), reconcile
 *      (every 30 minutes, an on-chain/liveness audit -- see jobs/reconcile.ts),
 *      and starts the status HTTP server. Refuses to start if `ORACLE_PROVIDER`
 *      disagrees with the on-chain `Config.oracle_provider`.
 *   `probe <pyth> [flags]` -- the Pyth token-day probe (research.md R5, tasks.md
 *      T090); never touches the cron/job machinery above, does not require
 *      `ORACLE_PROVIDER=pyth` to be set.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { schedule } from "node-cron";

import { loadConfig, type AppConfig } from "./config.js";
import { loadAdminKeypair, loadPublisherKeypair } from "./keys.js";
import { assertGenesisHash, ChainClient, CONFIRM_TRANSACTION_TIMEOUT_MS } from "./chain.js";
import { MockPythProvider } from "./providers/MockPythProvider.js";
import { PythReceiverProvider } from "./providers/PythReceiverProvider.js";
import type { PriceProvider } from "./providers/PriceProvider.js";
import { runMorningJob } from "./jobs/morning.js";
import { runSettleJob, settlementStatus } from "./jobs/settle.js";
import { isWithinPublishWindow, runPublisherJob, runPublisherTick } from "./jobs/publisher.js";
import { runReclaimJob } from "./jobs/reclaim.js";
import { loadExtendState, saveExtendState, runExtendTick, createGuardedExtendTick } from "./jobs/extend.js";
import { runReconcileJob, lastReconcile } from "./jobs/reconcile.js";
import { recordJobCompletion, getJobRegistrySnapshot } from "./job-registry.js";
import { startStatusServer } from "./status.js";
import { EventIndex } from "./events-index.js";
import { log, logError } from "./log.js";
import { runPyth } from "./probe/pyth.js";
import { PROGRAM_ID } from "@meridian/sdk";

const ET_TIMEZONE = "America/New_York";

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function flagNumber(flags: Flags, name: string): number | undefined {
  const value = flags[name];
  return typeof value === "string" ? Number(value) : undefined;
}

function flagBoolean(flags: Flags, name: string): boolean {
  return Boolean(flags[name]);
}

interface Runtime {
  chain: ChainClient;
  provider: PriceProvider;
  cfg: AppConfig;
}

function buildRuntime(cfg: AppConfig): Runtime {
  const connection = new Connection(cfg.solanaRpcUrl, {
    wsEndpoint: cfg.solanaWsUrl,
    commitment: "confirmed",
    confirmTransactionInitialTimeout: CONFIRM_TRANSACTION_TIMEOUT_MS,
  });
  const adminKeypair = loadAdminKeypair(cfg.adminKeypairPath);
  const publisherKeypair = loadPublisherKeypair(cfg.publisherKeypairPath);
  const chain = new ChainClient({
    connection,
    adminKeypair,
    publisherKeypair,
    usdcMint: new PublicKey(cfg.usdcMint),
  });

  let provider: PriceProvider;
  if (cfg.oracleProvider === "mock") {
    if (!cfg.finnhubApiKey) {
      throw new Error("FINNHUB_API_KEY is required when ORACLE_PROVIDER=mock");
    }
    provider = new MockPythProvider({ chain, finnhubApiKey: cfg.finnhubApiKey });
  } else {
    if (!cfg.pythApiKey) {
      throw new Error("PYTH_API_KEY is required when ORACLE_PROVIDER=pyth");
    }
    provider = new PythReceiverProvider({
      chain,
      connection,
      publisherKeypair,
      receiverProgramId: new PublicKey(cfg.pythReceiverProgram),
      hermesBaseUrl: cfg.pythHermesUrl,
      pythApiKey: cfg.pythApiKey,
      finnhubApiKey: cfg.finnhubApiKey,
    });
  }

  return { chain, provider, cfg };
}

async function assertOracleProviderMatchesChain(runtime: Runtime): Promise<void> {
  const onChainConfig = await runtime.chain.fetchConfig();
  if (onChainConfig.oracleProvider !== runtime.cfg.oracleProvider) {
    throw new Error(
      `ORACLE_PROVIDER="${runtime.cfg.oracleProvider}" disagrees with on-chain ` +
        `Config.oracle_provider="${onChainConfig.oracleProvider}"; refusing to start`,
    );
  }
}

async function dispatchJob(name: string, flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const runtime = buildRuntime(cfg);
  // Fix #3: checked once at startup, before any transaction -- via the connection's genesis
  // hash rather than trusting SOLANA_RPC_URL's hostname.
  await assertGenesisHash(runtime.chain.connection, cfg.solanaCluster);
  // Fix #14: every chain-backed job (not just `start`) refuses to run against a mismatched
  // ORACLE_PROVIDER -- previously only the long-running `start` process checked this.
  await assertOracleProviderMatchesChain(runtime);
  const day = flagNumber(flags, "day");

  switch (name) {
    case "morning": {
      const closeInSeconds = flagNumber(flags, "close-in");
      const force = flagBoolean(flags, "force");
      await runMorningJob(
        {
          chain: runtime.chain,
          provider: runtime.provider,
          demoScale: cfg.demoScale,
          alertWebhookUrl: cfg.alertWebhookUrl,
        },
        { day, closeInSeconds, force },
      );
      return;
    }
    case "settle": {
      await runSettleJob(
        { chain: runtime.chain, provider: runtime.provider, alertWebhookUrl: cfg.alertWebhookUrl },
        { day, once: flagBoolean(flags, "once"), force: flagBoolean(flags, "force") },
      );
      return;
    }
    case "publisher": {
      await runPublisherJob(
        { chain: runtime.chain, provider: runtime.provider, oracleProvider: cfg.oracleProvider },
        { once: flagBoolean(flags, "once") },
      );
      return;
    }
    case "reclaim": {
      await runReclaimJob(
        { chain: runtime.chain },
        { day, allSettled: flagBoolean(flags, "all-settled"), dryRun: flagBoolean(flags, "dry-run") },
      );
      return;
    }
    case "extend": {
      // `job extend --once [--force]`: a single tick now, for manual devnet testing
      // (contracts/automation.md's dry-run-safety shape). `--force` ignores the
      // 09:35-15:45 ET window/trading-day gate; without it this can legitimately do
      // nothing outside that window, same as `publisher --once` outside its window.
      // Review fix #9: state is loaded from/saved to EXTEND_STATE_PATH (not a fresh
      // `createExtendState()` every invocation) so two manual invocations five minutes
      // apart accumulate the same two-consecutive-tick streak a live cron tick would.
      const state = await loadExtendState(cfg.extendStatePath);
      try {
        await runExtendTick(
          { chain: runtime.chain, provider: runtime.provider, demoScale: cfg.demoScale, state },
          { day, force: flagBoolean(flags, "force") },
        );
      } finally {
        await saveExtendState(cfg.extendStatePath, state);
      }
      return;
    }
    case "reconcile": {
      await runReconcileJob({ chain: runtime.chain, alertWebhookUrl: cfg.alertWebhookUrl }, { day });
      return;
    }
    default:
      throw new Error(`unknown job "${name}"; expected morning, settle, publisher, reclaim, extend, or reconcile`);
  }
}

async function runStart(): Promise<void> {
  const cfg = loadConfig();
  const runtime = buildRuntime(cfg);
  // Fix #3: checked once at startup, before any transaction.
  await assertGenesisHash(runtime.chain.connection, cfg.solanaCluster);
  await assertOracleProviderMatchesChain(runtime);

  const eventIndex = new EventIndex({
    connection: runtime.chain.connection,
    programId: PROGRAM_ID,
    snapshotPath: cfg.eventIndexPath,
    fetchSpacingMs: cfg.eventFetchSpacingMs,
    pollIntervalMs: cfg.eventPollIntervalMs,
  });
  // Not awaited: the initial backfill can take minutes against program history, and the status
  // server (including `/events`, which just reports whatever the index has indexed so far, with
  // `complete: false` until this finishes) should be reachable immediately.
  eventIndex.start().catch((err) => logError({ job: "events-index", step: "start", ok: false, error: (err as Error).message }));

  startStatusServer(
    cfg.automationStatusPort,
    settlementStatus,
    cfg.webOrigin,
    eventIndex,
    getJobRegistrySnapshot,
    () => lastReconcile,
  );
  log({ job: "index", step: "status_server", ok: true, error: `listening on :${cfg.automationStatusPort}` });

  schedule(
    "0 8 * * 1-5",
    () => {
      runMorningJob({
        chain: runtime.chain,
        provider: runtime.provider,
        demoScale: cfg.demoScale,
        alertWebhookUrl: cfg.alertWebhookUrl,
      })
        .then(() => recordJobCompletion("morning"))
        .catch((err) => logError({ job: "morning", step: "cron", ok: false, error: (err as Error).message }));
    },
    { timezone: ET_TIMEZONE },
  );

  schedule(
    "30 0 16 * * 1-5",
    () => {
      runSettleJob({
        chain: runtime.chain,
        provider: runtime.provider,
        alertWebhookUrl: cfg.alertWebhookUrl,
      })
        .then(() => recordJobCompletion("settle"))
        .catch((err) => logError({ job: "settle", step: "cron", ok: false, error: (err as Error).message }));
    },
    { timezone: ET_TIMEZONE },
  );

  // Fix #19: a per-minute cron tick gated on the 09:25-16:10 ET trading-day window, rather than
  // a single 09:25 kickoff that holds one long-running promise (and an internal sleep loop) for
  // the rest of the day. A mid-day restart, or one tick throwing, no longer disables publishing
  // for the rest of the day -- each tick is scheduled and isolated independently.
  // Fix #20: the publisher job only ever runs against the mock provider (runPublisherTick
  // throws otherwise); scheduling the tick regardless of ORACLE_PROVIDER meant every minute
  // logged a doomed-to-fail error under the pyth provider. Only register the cron when the
  // provider is actually mock.
  if (cfg.oracleProvider === "mock") {
    schedule(
      "* * * * *",
      () => {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!isWithinPublishWindow(nowSeconds)) return;
        runPublisherTick({
          chain: runtime.chain,
          provider: runtime.provider,
          oracleProvider: cfg.oracleProvider,
        }).catch((err) =>
          logError({ job: "publisher", step: "cron_tick", ok: false, error: (err as Error).message }),
        );
      },
      { timezone: ET_TIMEZONE },
    );
  }

  schedule(
    "0 20 * * 1-5",
    () => {
      runReclaimJob({ chain: runtime.chain })
        .then(() => recordJobCompletion("reclaim"))
        .catch((err) => logError({ job: "reclaim", step: "cron", ok: false, error: (err as Error).message }));
    },
    { timezone: ET_TIMEZONE },
  );

  // DECISIONS.md §27: a 5-minute tick, every weekday, for the whole day -- the window gate
  // (09:35-15:45 ET on trading days) lives inside `runExtendTick` itself (not here), the same
  // way `job extend --once --force` bypasses it for manual testing. `extendState` is loaded
  // once here (review fix #9: from EXTEND_STATE_PATH, not a fresh `createExtendState()`) and
  // threaded into every tick, and saved back after each one, so a worker restart no longer
  // resets the two-consecutive-tick streaks or the per-day creation cap.
  const extendState = await loadExtendState(cfg.extendStatePath);
  // Review fix #5: `createGuardedExtendTick`'s in-flight guard (released in `finally`) means
  // a slow tick (slow RPC calls, a book retry loop) can never overlap with the next scheduled
  // tick -- overlapping ticks would share `extendState` with no synchronization, which could
  // double-spend the per-day cap. Review fix #9: `extendState` is saved back after every tick.
  const extendTick = createGuardedExtendTick(
    () => ({ chain: runtime.chain, provider: runtime.provider, demoScale: cfg.demoScale, state: extendState }),
    {
      onSettled: () => {
        // Recorded on every tick, gated or not: see job-registry.ts's module doc comment on why
        // this is a liveness signal on the scheduler itself, not a correctness signal on any one
        // tick's outcome (the same way index.ts's own cron fires every 5 min regardless of the
        // 09:35-15:45 ET window that `runExtendTick` gates internally).
        recordJobCompletion("extend");
        saveExtendState(cfg.extendStatePath, extendState).catch((err) =>
          logError({ job: "extend", step: "state_save", ok: false, error: (err as Error).message }),
        );
      },
    },
  );
  schedule("*/5 * * * 1-5", extendTick, { timezone: ET_TIMEZONE });

  // Every 30 minutes, every day: an audit pass, not a mutating job, so it runs on weekends too
  // (jobs/reconcile.ts's own checks are each individually gated to when they're meaningful --
  // e.g. the morning-ladder check only fires on a trading day after 08:30 ET).
  schedule(
    "*/30 * * * *",
    () => {
      runReconcileJob({ chain: runtime.chain, alertWebhookUrl: cfg.alertWebhookUrl })
        .catch((err) => logError({ job: "reconcile", step: "cron", ok: false, error: (err as Error).message }));
    },
    { timezone: ET_TIMEZONE },
  );

  log({
    job: "index",
    step: "cron",
    ok: true,
    error:
      `morning 08:00, settle 16:00:30, ` +
      (cfg.oracleProvider === "mock"
        ? "publisher every minute gated 09:25-16:10"
        : "publisher disabled (pyth provider)") +
      `, reclaim 20:00, extend every 5 min 09:35-15:45, reconcile every 30 min (America/New_York)`,
  });
}

async function main(): Promise<void> {
  const [, , cmd, sub, ...rest] = process.argv;

  if (cmd === "job") {
    if (!sub) {
      throw new Error("usage: job <morning|settle|publisher|reclaim|extend|reconcile> [flags]");
    }
    await dispatchJob(sub, parseFlags(rest));
    return;
  }

  if (cmd === "start") {
    await runStart();
    return; // cron + the status server keep the process alive
  }

  if (cmd === "probe") {
    if (sub !== "pyth") {
      throw new Error('usage: probe pyth [--feed <hex>] [--post]');
    }
    await runPyth(parseFlags(rest));
    return;
  }

  if (cmd === "dry-run") {
    // Smoke-test path (item 1): exercises the real module boundary --
    // config.ts, keys.ts, chain.ts (which imports @meridian/sdk) -- without
    // ever touching the network. Used by test/cli.test.ts to prove the CLI
    // actually starts under the real `tsx` entry point, not just under the
    // test runner's module resolution.
    const cfg = loadConfig();
    buildRuntime(cfg);
    console.log(JSON.stringify({ ok: true, step: "dry-run" }));
    return;
  }

  console.error(
    "usage: automation job <morning|settle|publisher|reclaim|extend|reconcile> [flags] | automation start | " +
      "automation probe pyth [flags] | automation dry-run",
  );
  process.exitCode = 1;
}

main().catch((err) => {
  logError({ job: "index", step: "main", ok: false, error: (err as Error).message });
  process.exitCode = 1;
});
