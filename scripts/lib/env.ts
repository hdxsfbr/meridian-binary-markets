/**
 * Environment configuration for the operational scripts (rent-estimate,
 * airdrop, deploy, init-config). Mirrors the shape of
 * `services/automation/src/config.ts` but scoped to what the scripts need:
 * `CLUSTER` only ever allows `localnet` or `devnet` (DECISIONS §3 refuses
 * `mainnet-beta` outright; `localnet` is additionally valid here because
 * these scripts, unlike the automation service, are run against a local
 * validator too).
 */

import { z } from "zod";
import { PublicKey } from "@solana/web3.js";

const clusterEnum = z.enum(["localnet", "devnet"]);
const oracleProviderEnum = z.enum(["mock", "pyth"]);

function solanaPubkey(label: string) {
  return z.string().min(1).refine(
    (v) => {
      try {
        new PublicKey(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: `${label} must be a valid Solana public key` },
  );
}

const booleanFromFlag = z
  .union([z.literal("0"), z.literal("1"), z.undefined()])
  .transform((v) => v === "1");

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed === "" ? undefined : trimmed;
  });

function defaultRpcUrlFor(cluster: "localnet" | "devnet"): string {
  return cluster === "localnet" ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com";
}

function defaultAdminKeypairPath(): string {
  return "/run/keys/admin.json";
}

const rawSchema = z.object({
  CLUSTER: clusterEnum,
  SOLANA_RPC_URL: optionalNonEmpty,
  ADMIN_KEYPAIR_PATH: optionalNonEmpty,
  PUBLISHER_KEYPAIR_PATH: optionalNonEmpty,
  USDC_MINT: optionalNonEmpty,
  ORACLE_PROVIDER: oracleProviderEnum.default("mock"),
  DEMO_SCALE: booleanFromFlag,
  PYTH_RECEIVER_PROGRAM: optionalNonEmpty,
});

export type ScriptEnv = {
  cluster: "localnet" | "devnet";
  solanaRpcUrl: string;
  /** Falls back to `/run/keys/admin.json`, then `~/.config/solana/id.json`, resolved by `lib/keys.ts`. */
  adminKeypairPath: string;
  /** Falls back to `/run/keys/publisher.json`. */
  publisherKeypairPath: string;
  /** Unset means: use Circle devnet USDC on devnet, or create a fresh local mint on localnet. */
  usdcMint?: string;
  oracleProvider: "mock" | "pyth";
  demoScale: boolean;
  pythReceiverProgram?: string;
};

class EnvError extends Error {}

/**
 * Parses and validates `env` into a `ScriptEnv`. Throws a single `Error`
 * listing every invalid field. `CLUSTER` is required and restricted to
 * `localnet`/`devnet`; anything else (including `mainnet-beta`) is refused.
 */
export function loadScriptEnv(env: NodeJS.ProcessEnv = process.env): ScriptEnv {
  const result = rawSchema.safeParse(env);

  const issues: string[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join(".") || "(root)";
      issues.push(`${field}: ${issue.message}`);
    }
  }

  if (env.CLUSTER !== undefined && env.CLUSTER !== "localnet" && env.CLUSTER !== "devnet") {
    issues.push(
      `CLUSTER: "${env.CLUSTER}" is refused; only "localnet" or "devnet" are allowed (mainnet is never a target of these scripts)`,
    );
  }

  if (env.USDC_MINT !== undefined && env.USDC_MINT.trim() !== "") {
    try {
      new PublicKey(env.USDC_MINT.trim());
    } catch {
      issues.push(`USDC_MINT: "${env.USDC_MINT}" is not a valid Solana public key`);
    }
  }

  if (env.PYTH_RECEIVER_PROGRAM !== undefined && env.PYTH_RECEIVER_PROGRAM.trim() !== "") {
    try {
      new PublicKey(env.PYTH_RECEIVER_PROGRAM.trim());
    } catch {
      issues.push(`PYTH_RECEIVER_PROGRAM: "${env.PYTH_RECEIVER_PROGRAM}" is not a valid Solana public key`);
    }
  }

  if (issues.length > 0) {
    throw new EnvError(`Invalid script environment:\n${issues.map((m) => `  - ${m}`).join("\n")}`);
  }

  const raw = result.data!;
  const cluster = raw.CLUSTER;

  return {
    cluster,
    solanaRpcUrl: raw.SOLANA_RPC_URL ?? defaultRpcUrlFor(cluster),
    adminKeypairPath: raw.ADMIN_KEYPAIR_PATH ?? defaultAdminKeypairPath(),
    publisherKeypairPath: raw.PUBLISHER_KEYPAIR_PATH ?? "/run/keys/publisher.json",
    usdcMint: raw.USDC_MINT,
    oracleProvider: raw.ORACLE_PROVIDER,
    demoScale: raw.DEMO_SCALE,
    pythReceiverProgram: raw.PYTH_RECEIVER_PROGRAM,
  };
}
