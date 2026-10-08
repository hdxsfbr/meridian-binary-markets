/**
 * Environment configuration for the automation service, validated against
 * every variable in `.env.example` (contracts/oracle-provider.md
 * "Environment variables"). `mainnet-beta` is refused outright (DECISIONS
 * §3): the cluster enum only ever allows `devnet` or `localnet`.
 */

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const clusterEnum = z.enum(["devnet", "localnet"]);
const oracleProviderEnum = z.enum(["mock", "pyth"]);

const booleanFromFlag = z
  .union([z.literal("0"), z.literal("1")])
  .transform((v) => v === "1");

const portNumber = z
  .string()
  .regex(/^\d+$/, "must be an integer")
  .transform((v) => Number(v))
  .pipe(z.number().int().min(1).max(65535));

// Trims the value and treats empty-after-trim as absent, so a whitespace-only credential
// (e.g. PYTH_API_KEY=" ") is treated the same as an unset one.
const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed === "" ? undefined : trimmed;
  });

function httpUrl(label: string) {
  return z.string().url().refine(
    (v) => v.startsWith("http://") || v.startsWith("https://"),
    { message: `${label} must use the http: or https: scheme` },
  );
}

const wsUrl = z.string().url().refine(
  (v) => v.startsWith("ws://") || v.startsWith("wss://"),
  { message: "SOLANA_WS_URL must use the ws: or wss: scheme" },
);

// Same trim-empty-to-undefined behavior as optionalNonEmpty, plus a scheme check applied
// only when the value is present.
function optionalHttpUrlFor(label: string) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const trimmed = v.trim();
      return trimmed === "" ? undefined : trimmed;
    })
    .refine((v) => v === undefined || v.startsWith("http://") || v.startsWith("https://"), {
      message: `${label} must use the http: or https: scheme`,
    });
}

const optionalHttpUrl = optionalHttpUrlFor("ALERT_WEBHOOK_URL");

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

const rawConfigSchema = z.object({
  SOLANA_CLUSTER: clusterEnum,
  SOLANA_RPC_URL: httpUrl("SOLANA_RPC_URL"),
  SOLANA_WS_URL: wsUrl,
  // Paths may be left at their defaults when the keypairs arrive as
  // `ADMIN_KEYPAIR_JSON` / `PUBLISHER_KEYPAIR_JSON` instead (see keys.ts).
  ADMIN_KEYPAIR_PATH: z.string().min(1).default("/run/keys/admin.json"),
  PUBLISHER_KEYPAIR_PATH: z.string().min(1).default("/run/keys/publisher.json"),
  USDC_MINT: solanaPubkey("USDC_MINT"),
  ORACLE_PROVIDER: oracleProviderEnum,
  PYTH_HERMES_URL: httpUrl("PYTH_HERMES_URL"),
  PYTH_API_KEY: optionalNonEmpty,
  PYTH_RECEIVER_PROGRAM: solanaPubkey("PYTH_RECEIVER_PROGRAM"),
  FINNHUB_API_KEY: optionalNonEmpty,
  ALERT_WEBHOOK_URL: optionalHttpUrl,
  // An empty value (a host whose port template resolved to nothing) falls back to the default.
  AUTOMATION_STATUS_PORT: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), portNumber.default("8787")),
  DEMO_SCALE: booleanFromFlag,
  // Fix #22: CORS origin for the status endpoint. Optional URL, defaulting to the local web
  // dev server (`.env.example` needs a `WEB_ORIGIN=` line documenting this; not added here --
  // out of scope for this file).
  WEB_ORIGIN: optionalHttpUrlFor("WEB_ORIGIN"),
});

export type AppConfig = {
  solanaCluster: "devnet" | "localnet";
  solanaRpcUrl: string;
  solanaWsUrl: string;
  adminKeypairPath: string;
  publisherKeypairPath: string;
  usdcMint: string;
  oracleProvider: "mock" | "pyth";
  pythHermesUrl: string;
  pythApiKey?: string;
  pythReceiverProgram: string;
  finnhubApiKey?: string;
  alertWebhookUrl?: string;
  automationStatusPort: number;
  demoScale: boolean;
  /** CORS origin for the status endpoint (fix #22). Defaults to the local web dev server. */
  webOrigin: string;
};

class ConfigError extends Error {}

/**
 * Parses and validates `env` into an `AppConfig`. Throws a single `Error`
 * whose message lists every invalid field (not just the first).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = rawConfigSchema.safeParse(env);

  const issues: string[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join(".") || "(root)";
      issues.push(`${field}: ${issue.message}`);
    }
  }

  // DECISIONS §3: mainnet-beta is refused outright, with a clear message. Checked against the
  // raw env value (not the parsed result) so the message appears even though the enum above
  // already rejects "mainnet-beta" with a generic zod message.
  if ((env.SOLANA_CLUSTER as string | undefined) === "mainnet-beta") {
    issues.push(
      `SOLANA_CLUSTER: "mainnet-beta" is refused (DECISIONS §3); only "devnet" or "localnet" are allowed`,
    );
  }

  // Cross-field rule (contracts/oracle-provider.md "Selection"): ORACLE_PROVIDER=mock is refused
  // unless the cluster is devnet or localnet. The enum above already only allows those two
  // values, but the check is implemented explicitly so it survives if the enum later widens.
  const cluster = env.SOLANA_CLUSTER as string | undefined;
  if (env.ORACLE_PROVIDER === "mock" && cluster !== "devnet" && cluster !== "localnet") {
    issues.push(
      `ORACLE_PROVIDER: "mock" is refused unless SOLANA_CLUSTER is "devnet" or "localnet" (got "${cluster}")`,
    );
  }

  // Checked against the trimmed value (empty-after-trim counts as absent), consistent with
  // optionalNonEmpty's treatment of whitespace-only credentials.
  const trimmedPythApiKey = (env.PYTH_API_KEY as string | undefined)?.trim();
  if (env.ORACLE_PROVIDER === "pyth" && !trimmedPythApiKey) {
    issues.push(`PYTH_API_KEY: required when ORACLE_PROVIDER is "pyth"`);
  }

  if (issues.length > 0) {
    throw new ConfigError(`Invalid automation config:\n${issues.map((m) => `  - ${m}`).join("\n")}`);
  }

  const raw = result.data!;

  return {
    solanaCluster: raw.SOLANA_CLUSTER,
    solanaRpcUrl: raw.SOLANA_RPC_URL,
    solanaWsUrl: raw.SOLANA_WS_URL,
    adminKeypairPath: raw.ADMIN_KEYPAIR_PATH,
    publisherKeypairPath: raw.PUBLISHER_KEYPAIR_PATH,
    usdcMint: raw.USDC_MINT,
    oracleProvider: raw.ORACLE_PROVIDER,
    pythHermesUrl: raw.PYTH_HERMES_URL,
    pythApiKey: raw.PYTH_API_KEY,
    pythReceiverProgram: raw.PYTH_RECEIVER_PROGRAM,
    finnhubApiKey: raw.FINNHUB_API_KEY,
    alertWebhookUrl: raw.ALERT_WEBHOOK_URL,
    automationStatusPort: raw.AUTOMATION_STATUS_PORT,
    demoScale: raw.DEMO_SCALE,
    webOrigin: raw.WEB_ORIGIN ?? "http://localhost:3000",
  };
}
