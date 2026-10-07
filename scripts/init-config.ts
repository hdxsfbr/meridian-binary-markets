#!/usr/bin/env -S node --
/**
 * `make init-config` / `pnpm --filter @meridian/scripts run init-config`.
 *
 * Idempotent: if the `Config` singleton already exists and `--update` was
 * not passed, prints it and exits 0 without sending a transaction. Without
 * `--update`, a missing `Config` is created via `initialize_config` with:
 *
 * - `oracle_provider`/`oracle_program` from `ORACLE_PROVIDER` (mock ->
 *   `oracle_program = PROGRAM_ID`; pyth -> `PYTH_RECEIVER_PROGRAM`),
 * - `publishers = [publisher pubkey]` (the one key loaded from
 *   `PUBLISHER_KEYPAIR_PATH`),
 * - thresholds 300s staleness / 25 bps confidence / 60s publish offset /
 *   3600s override delay (tasks.md T085),
 * - the seven tickers with their `Equity.US` feed ids from `@meridian/sdk`,
 * - `default_book_capacity` 16 if `DEMO_SCALE=1`, else 128,
 * - the USDC mint: from `USDC_MINT` on devnet (required, must be 6
 *   decimals), or a freshly created 6-decimal test mint on localnet if
 *   `USDC_MINT` is unset.
 *
 * `--update` calls `update_config` with only the fields implied by the
 * flags given (`--provider pyth|mock`, `--capacity N`), plus `pause`/
 * `unpause` for `--paused`/`--no-paused` (the program has no `paused`
 * field on `UpdateConfigArgs` -- `Config.paused` is flipped by its own
 * admin-only instruction, `programs/meridian/src/instructions/pause.rs`).
 */

import { fileURLToPath } from "node:url";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { feedIdBytes, PROGRAM_ID, tickerSymbolBytes, TICKERS, configPda } from "@meridian/sdk";
import { loadScriptEnv } from "./lib/env.js";
import { assertGenesisHash, confirm, createConnection, createTestMint, getMintDecimals, loadProgram } from "./lib/client.js";
import { resolveAdminKeypair, resolveKeypair } from "./lib/keys.js";

export const THRESHOLDS = {
  maxStalenessSecs: 300,
  maxConfBps: 25,
  minPublishOffsetSecs: 60,
  overrideDelaySecs: 3600,
} as const;

export interface TickerInfoArg {
  symbol: number[];
  feedId: number[];
  enabled: boolean;
}

export interface InitializeConfigArgsPlain {
  oracleProvider: { mockPyth: Record<string, never> } | { pythReceiver: Record<string, never> };
  oracleProgram: PublicKey;
  publishers: PublicKey[];
  maxStalenessSecs: number;
  maxConfBps: number;
  minPublishOffsetSecs: number;
  overrideDelaySecs: number;
  tickers: TickerInfoArg[];
  defaultBookCapacity: number;
}

export interface BuildArgsOptions {
  oracleProvider: "mock" | "pyth";
  programId: PublicKey;
  pythReceiverProgram?: PublicKey;
  publisher: PublicKey;
  demoScale: boolean;
}

/**
 * Pure builder for `InitializeConfigArgs` (no RPC, no file access) so the
 * mock/pyth and demo/default branches can be tested directly
 * (`test/init-config.test.ts`).
 */
export function buildInitializeConfigArgs(opts: BuildArgsOptions): InitializeConfigArgsPlain {
  if (opts.oracleProvider === "pyth" && !opts.pythReceiverProgram) {
    throw new Error("buildInitializeConfigArgs: ORACLE_PROVIDER=pyth requires PYTH_RECEIVER_PROGRAM");
  }

  const tickers: TickerInfoArg[] = TICKERS.map((ticker) => ({
    symbol: Array.from(tickerSymbolBytes(ticker)),
    feedId: Array.from(feedIdBytes(ticker)),
    enabled: true,
  }));

  return {
    oracleProvider: opts.oracleProvider === "mock" ? { mockPyth: {} } : { pythReceiver: {} },
    oracleProgram: opts.oracleProvider === "mock" ? opts.programId : opts.pythReceiverProgram!,
    publishers: [opts.publisher],
    ...THRESHOLDS,
    tickers,
    defaultBookCapacity: opts.demoScale ? 16 : 128,
  };
}

function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function printTickerTable(tickers: Array<{ symbol: number[] | Uint8Array; feedId: number[] | Uint8Array; enabled: boolean }>) {
  for (const t of tickers) {
    const bytes = Uint8Array.from(t.symbol as Iterable<number>);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    const symbol = Buffer.from(bytes.slice(0, end)).toString("ascii");
    const feedHex = Buffer.from(Uint8Array.from(t.feedId as Iterable<number>)).toString("hex");
    console.log(`    ${symbol.padEnd(6)} enabled=${t.enabled} feed=${feedHex}`);
  }
}

function printConfig(raw: Record<string, unknown>, configAddress: PublicKey): void {
  const providerKey = raw.oracleProvider && typeof raw.oracleProvider === "object"
    ? Object.keys(raw.oracleProvider as Record<string, unknown>)[0]
    : String(raw.oracleProvider);

  console.log(`Config PDA: ${configAddress.toBase58()}`);
  console.log(`  admin:                   ${(raw.admin as PublicKey).toBase58()}`);
  console.log(`  paused:                  ${raw.paused}`);
  console.log(`  usdc_mint:               ${(raw.usdcMint as PublicKey).toBase58()}`);
  console.log(`  oracle_provider:         ${providerKey}`);
  console.log(`  oracle_program:          ${(raw.oracleProgram as PublicKey).toBase58()}`);
  const publishersLen = Number(raw.publishersLen ?? 0);
  const publishers = (raw.publishers as PublicKey[]).slice(0, publishersLen).map((p) => p.toBase58());
  console.log(`  publishers (${publishersLen}):          ${publishers.join(", ")}`);
  console.log(`  max_staleness_secs:      ${raw.maxStalenessSecs}`);
  console.log(`  max_conf_bps:            ${raw.maxConfBps}`);
  console.log(`  min_publish_offset_secs: ${raw.minPublishOffsetSecs}`);
  console.log(`  override_delay_secs:     ${raw.overrideDelaySecs}`);
  console.log(`  default_book_capacity:   ${raw.defaultBookCapacity}`);
  console.log(`  tickers:`);
  printTickerTable(raw.tickers as Array<{ symbol: number[]; feedId: number[]; enabled: boolean }>);
}

async function resolveUsdcMint(
  env: ReturnType<typeof loadScriptEnv>,
  connection: ReturnType<typeof createConnection>,
  admin: ReturnType<typeof resolveAdminKeypair>,
): Promise<PublicKey> {
  if (env.usdcMint) {
    const mint = new PublicKey(env.usdcMint);
    const decimals = await getMintDecimals(connection, mint);
    if (decimals !== 6) {
      throw new Error(
        `init-config: USDC_MINT ${mint.toBase58()} has ${decimals} decimals, expected 6`,
      );
    }
    return mint;
  }
  if (env.cluster === "devnet") {
    throw new Error(
      "init-config: USDC_MINT is required on devnet (Circle devnet USDC: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)",
    );
  }
  console.log("init-config: USDC_MINT not set on localnet, creating a fresh 6-decimal test mint");
  const mint = await createTestMint(connection, admin, 6, admin.publicKey);
  console.log(`init-config: created test USDC mint ${mint.toBase58()} (admin is mint authority)`);
  return mint;
}

async function main(): Promise<void> {
  const argv = process.argv;
  const isUpdate = argv.includes("--update");
  const providerFlag = parseFlag(argv, "--provider");
  const capacityFlag = parseFlag(argv, "--capacity");
  const pausedFlag = argv.includes("--paused");
  const unpausedFlag = argv.includes("--no-paused");

  const env = loadScriptEnv();
  const connection = createConnection(env.solanaRpcUrl);
  await assertGenesisHash(connection, env.cluster);
  const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
  const [configAddress] = configPda(PROGRAM_ID);

  const program = loadProgram(connection, admin);
  const existing = await program.account.config.fetchNullable(configAddress);

  if (existing && !isUpdate) {
    console.log("init-config: Config already exists, nothing to do");
    printConfig(existing as Record<string, unknown>, configAddress);
    return;
  }

  if (existing && isUpdate) {
    const args: Record<string, unknown> = {};
    if (providerFlag === "pyth") {
      if (!env.pythReceiverProgram) {
        throw new Error("init-config: --provider pyth requires PYTH_RECEIVER_PROGRAM");
      }
      args.oracleProvider = { pythReceiver: {} };
      args.oracleProgram = new PublicKey(env.pythReceiverProgram);
    } else if (providerFlag === "mock") {
      args.oracleProvider = { mockPyth: {} };
      args.oracleProgram = PROGRAM_ID;
    } else if (providerFlag !== undefined) {
      throw new Error(`init-config: --provider must be "mock" or "pyth", got "${providerFlag}"`);
    }

    if (capacityFlag !== undefined) {
      const capacity = Number(capacityFlag);
      if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new Error(`init-config: --capacity must be a positive integer, got "${capacityFlag}"`);
      }
      args.defaultBookCapacity = capacity;
    }

    const hasUpdateConfigChange = Object.keys(args).length > 0;
    if (hasUpdateConfigChange) {
      console.log(`init-config: update_config(${JSON.stringify(args, (_, v) => (v instanceof PublicKey ? v.toBase58() : v))})`);
      const sig = await program.methods
        .updateConfig(args)
        .accountsStrict({ admin: admin.publicKey, config: configAddress })
        .signers([admin])
        .rpc();
      await confirm(connection, sig);
    }

    if (pausedFlag || unpausedFlag) {
      const method = pausedFlag ? "pause" : "unpause";
      console.log(`init-config: ${method}()`);
      const sig = await program.methods[method]()
        .accountsStrict({ admin: admin.publicKey, config: configAddress })
        .signers([admin])
        .rpc();
      await confirm(connection, sig);
    }

    if (!hasUpdateConfigChange && !pausedFlag && !unpausedFlag) {
      console.log("init-config: --update given but no flags implied a change; nothing sent");
    }

    const updated = await program.account.config.fetch(configAddress);
    printConfig(updated as Record<string, unknown>, configAddress);
    return;
  }

  // No existing Config: create it.
  const publisher = resolveKeypair(env.publisherKeypairPath, { createIfMissing: env.cluster === "localnet" });
  const usdcMint = await resolveUsdcMint(env, connection, admin);

  const args = buildInitializeConfigArgs({
    oracleProvider: env.oracleProvider,
    programId: PROGRAM_ID,
    pythReceiverProgram: env.pythReceiverProgram ? new PublicKey(env.pythReceiverProgram) : undefined,
    publisher: publisher.publicKey,
    demoScale: env.demoScale,
  });

  console.log(`init-config: initialize_config (provider=${env.oracleProvider}, capacity=${args.defaultBookCapacity}, usdc_mint=${usdcMint.toBase58()})`);

  const sig = await program.methods
    .initializeConfig(args)
    .accountsStrict({
      payer: admin.publicKey,
      admin: admin.publicKey,
      config: configAddress,
      usdcMint,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();
  // AnchorProvider confirms at "processed" by default (AnchorProvider.defaultOptions());
  // explicitly wait for "confirmed" before reading the account back, since `program.account.*
  // .fetch` below uses the same commitment and would otherwise occasionally race a
  // just-landed transaction that hasn't reached "confirmed" yet.
  await confirm(connection, sig);

  const created = await program.account.config.fetch(configAddress);
  printConfig(created as Record<string, unknown>, configAddress);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
