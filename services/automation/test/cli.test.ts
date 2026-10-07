/**
 * Smoke test (item 1, "smoke half"): spawns the *real* CLI entry point under
 * `tsx` -- not the vitest module resolver -- to prove the module boundary
 * between this service and `@meridian/sdk` actually works at runtime. Unit
 * tests import `src/*.ts` directly through vitest's resolver, which can
 * mask a broken package `exports`/module-format boundary that only shows up
 * when Node's own resolver loads the real entry point.
 *
 * Uses `automation dry-run` (src/index.ts): it runs `loadConfig` -> `keys.ts`
 * -> `buildRuntime` (which constructs a `ChainClient`, importing
 * `@meridian/sdk`) without ever making a network call, so this test needs no
 * RPC node and never touches the network.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const SERVICE_ROOT = fileURLToPath(new URL("..", import.meta.url));

function writeKeypairFile(dir: string, name: string): string {
  const path = join(dir, name);
  const secretKey = Array.from(Keypair.generate().secretKey);
  writeFileSync(path, JSON.stringify(secretKey));
  return path;
}

function buildDryRunEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "meridian-automation-cli-test-"));
  const adminKeypairPath = writeKeypairFile(dir, "admin.json");
  const publisherKeypairPath = writeKeypairFile(dir, "publisher.json");

  return {
    ...process.env,
    SOLANA_CLUSTER: "localnet",
    SOLANA_RPC_URL: "http://127.0.0.1:8899",
    SOLANA_WS_URL: "ws://127.0.0.1:8900",
    ADMIN_KEYPAIR_PATH: adminKeypairPath,
    PUBLISHER_KEYPAIR_PATH: publisherKeypairPath,
    USDC_MINT: Keypair.generate().publicKey.toBase58(),
    ORACLE_PROVIDER: "mock",
    PYTH_HERMES_URL: "http://localhost:9999",
    PYTH_API_KEY: "",
    PYTH_RECEIVER_PROGRAM: Keypair.generate().publicKey.toBase58(),
    FINNHUB_API_KEY: "dry-run-dummy-key",
    ALERT_WEBHOOK_URL: "",
    AUTOMATION_STATUS_PORT: "8787",
    DEMO_SCALE: "0",
  };
}

describe("CLI smoke test (real tsx entry point)", () => {
  it(
    "automation dry-run loads config, keys, and @meridian/sdk, and exits 0 without touching the network",
    () => {
      const env = buildDryRunEnv();

      const result = spawnSync("pnpm", ["exec", "tsx", "src/index.ts", "dry-run"], {
        cwd: SERVICE_ROOT,
        env,
        encoding: "utf8",
        timeout: 60_000,
      });

      if (result.status !== 0) {
        throw new Error(
          `automation dry-run exited ${result.status} (signal ${result.signal}).\n` +
            `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"ok":true');
    },
    60_000,
  );
});
