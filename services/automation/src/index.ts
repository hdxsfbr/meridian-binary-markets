/**
 * Automation service entry point (contracts/automation.md, tasks.md T046).
 *
 * Two modes:
 *   `job <morning|settle|publisher|reclaim> [flags]` -- runs one job to completion
 *      and exits. The CLI entry points contract (contracts/automation.md).
 *   `start` -- registers the cron schedule (America/New_York) for morning
 *      (08:00), settle (16:00:30) and publisher (kicked off at 09:25, runs its
 *      own internal 60 s loop until the window closes), and starts the status
 *      HTTP server. Refuses to start if `ORACLE_PROVIDER` disagrees with the
 *      on-chain `Config.oracle_provider`.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { schedule } from "node-cron";

import { loadConfig, type AppConfig } from "./config.js";
import { loadAdminKeypair, loadPublisherKeypair } from "./keys.js";
import { assertGenesisHash, ChainClient } from "./chain.js";
import { MockPythProvider } from "./providers/MockPythProvider.js";
import type { PriceProvider } from "./providers/PriceProvider.js";
import { runMorningJob } from "./jobs/morning.js";
import { runSettleJob, settlementStatus } from "./jobs/settle.js";
import { isWithinPublishWindow, runPublisherJob, runPublisherTick } from "./jobs/publisher.js";
import { runReclaimJob } from "./jobs/reclaim.js";
import { startStatusServer } from "./status.js";
import { log, logError } from "./log.js";

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
    // contracts/oracle-provider.md "Pyth side": lands in a later wave.
    throw new Error("PythReceiverProvider is not implemented until a later wave");
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
        { chain: runtime.chain, provider: runtime.provider, demoScale: cfg.demoScale },
        { day, closeInSeconds, force },
      );
      return;
    }
    case "settle": {
      await runSettleJob(
        { chain: runtime.chain, provider: runtime.provider, alertWebhookUrl: cfg.alertWebhookUrl },
        { day, once: flagBoolean(flags, "once") },
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
    default:
      throw new Error(`unknown job "${name}"; expected morning, settle, publisher, or reclaim`);
  }
}

async function runStart(): Promise<void> {
  const cfg = loadConfig();
  const runtime = buildRuntime(cfg);
  // Fix #3: checked once at startup, before any transaction.
  await assertGenesisHash(runtime.chain.connection, cfg.solanaCluster);
  await assertOracleProviderMatchesChain(runtime);

  startStatusServer(cfg.automationStatusPort, settlementStatus, cfg.webOrigin);
  log({ job: "index", step: "status_server", ok: true, error: `listening on :${cfg.automationStatusPort}` });

  schedule(
    "0 8 * * 1-5",
    () => {
      runMorningJob({ chain: runtime.chain, provider: runtime.provider, demoScale: cfg.demoScale }).catch((err) =>
        logError({ job: "morning", step: "cron", ok: false, error: (err as Error).message }),
      );
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
      }).catch((err) => logError({ job: "settle", step: "cron", ok: false, error: (err as Error).message }));
    },
    { timezone: ET_TIMEZONE },
  );

  // Fix #19: a per-minute cron tick gated on the 09:25-16:10 ET trading-day window, rather than
  // a single 09:25 kickoff that holds one long-running promise (and an internal sleep loop) for
  // the rest of the day. A mid-day restart, or one tick throwing, no longer disables publishing
  // for the rest of the day -- each tick is scheduled and isolated independently.
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

  schedule(
    "0 20 * * 1-5",
    () => {
      runReclaimJob({ chain: runtime.chain }).catch((err) =>
        logError({ job: "reclaim", step: "cron", ok: false, error: (err as Error).message }),
      );
    },
    { timezone: ET_TIMEZONE },
  );

  log({
    job: "index",
    step: "cron",
    ok: true,
    error:
      "morning 08:00, settle 16:00:30, publisher every minute gated 09:25-16:10, reclaim 20:00 (America/New_York)",
  });
}

async function main(): Promise<void> {
  const [, , cmd, sub, ...rest] = process.argv;

  if (cmd === "job") {
    if (!sub) {
      throw new Error("usage: job <morning|settle|publisher|reclaim> [flags]");
    }
    await dispatchJob(sub, parseFlags(rest));
    return;
  }

  if (cmd === "start") {
    await runStart();
    return; // cron + the status server keep the process alive
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
    "usage: automation job <morning|settle|publisher|reclaim> [flags] | automation start | automation dry-run",
  );
  process.exitCode = 1;
}

main().catch((err) => {
  logError({ job: "index", step: "main", ok: false, error: (err as Error).message });
  process.exitCode = 1;
});
