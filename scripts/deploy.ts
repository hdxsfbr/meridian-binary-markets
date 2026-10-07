#!/usr/bin/env -S node --
/**
 * `make deploy` / `pnpm --filter @meridian/scripts run deploy`.
 *
 * Builds the program (`scripts/anchor-build.sh`, which also runs
 * `anchor keys sync` and regenerates `packages/sdk/src/program-id.ts`),
 * then `anchor deploy`s it to `CLUSTER`, parses the deployed program id out
 * of Anchor's own output, and verifies it matches `PROGRAM_ID` from the
 * SDK (the id `anchor keys sync` already wrote) and that the resulting
 * on-chain account is marked executable. Never targets `mainnet-beta`
 * (`lib/env.ts` refuses that cluster value outright); devnet deploys are
 * out of scope for this wave (Wave 7), but the script itself works
 * identically against either cluster the env schema allows.
 *
 * `--skip-build`: deploy the program already sitting in
 * `target/deploy/meridian.so` without rebuilding first.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { loadScriptEnv } from "./lib/env.js";
import { resolveAdminKeypair, resolveAdminKeypairPath } from "./lib/keys.js";
// Fix #19: `./lib/client.js` and `@meridian/sdk` both transitively depend on generated
// files (`packages/sdk/src/program-id.ts`, `idl.ts`) that `scripts/anchor-build.sh` writes;
// on a from-scratch checkout, before the first build, those files don't exist yet. Statically
// importing either here would crash at module load time -- before `main()` gets a chance to
// run the build. Both are imported dynamically instead, inside `main()`, after the build step.

// `pnpm --filter @meridian/scripts run <script>` sets `process.cwd()` to this package
// directory (`scripts/`), not the repo root -- but `anchor-build.sh`, `anchor.toml`, and
// `anchor deploy` all assume the repo root. Resolve it from this file's own location
// instead of trusting `process.cwd()`.
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");

function run(command: string, args: string[]): string {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", cwd: REPO_ROOT });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`deploy: "${command} ${args.join(" ")}" exited with code ${result.status}`);
  }
  return output;
}

/**
 * Program binaries grow over the life of this project (more instructions,
 * more accounts), and `anchor deploy` needs roughly 2x the `.so` size in
 * rent for the buffer + program data account. A single 2 SOL airdrop
 * (`airdrop.ts`'s default) comfortably covered early builds but stopped
 * being enough once the program passed ~300 KB. On `localnet` a local
 * validator airdrops freely, so top up the admin's balance here rather
 * than make every caller guess the right number of airdrops; on `devnet`
 * this is a no-op (the faucet is rate-limited, and the deploy must work
 * within whatever balance the operator already funded by hand).
 */
async function ensureLocalnetDeployFunds(
  connection: Connection,
  payer: PublicKey,
  cluster: "localnet" | "devnet",
): Promise<void> {
  if (cluster !== "localnet") return;

  let soFileBytes = 0;
  try {
    soFileBytes = statSync(join(REPO_ROOT, "target", "deploy", "meridian.so")).size;
  } catch {
    // Not built yet (first run before anchor-build.sh) -- fall back to a safe floor below.
  }
  // `anchor deploy` writes the program into a temporary buffer account the same size as
  // the `.so` file, then into the program-data account -- each needs its own rent
  // exemption, so ask the cluster what that costs (not a hand-rolled byte-rate constant)
  // and double it, plus a fixed pad for the smaller fixed-size accounts (program,
  // buffer-authority bookkeeping) `anchor deploy` also creates.
  const rentForProgramSize =
    soFileBytes > 0 ? await connection.getMinimumBalanceForRentExemption(soFileBytes) : 0;
  const neededLamports = Math.max(rentForProgramSize * 2 + LAMPORTS_PER_SOL, 2 * LAMPORTS_PER_SOL);

  const balance = await connection.getBalance(payer, "confirmed");
  if (balance >= neededLamports) return;

  const shortfall = neededLamports - balance;
  console.log(
    `deploy: topping up admin balance on localnet (have ${balance / LAMPORTS_PER_SOL} SOL, want ~${(neededLamports / LAMPORTS_PER_SOL).toFixed(2)} SOL for a ${soFileBytes}-byte program)`,
  );
  const signature = await connection.requestAirdrop(payer, shortfall);
  const latest = await connection.getLatestBlockhash("confirmed");
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) {
    throw new Error(`deploy: top-up airdrop failed: ${JSON.stringify(result.value.err)}`);
  }
}

/** Parses Anchor's `anchor deploy` output for the line `Program Id: <pubkey>`. */
export function parseProgramIdFromDeployOutput(output: string): string {
  const match = output.match(/Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (!match) {
    throw new Error("deploy: could not find \"Program Id: ...\" in `anchor deploy` output");
  }
  return match[1];
}

async function main(): Promise<void> {
  const env = loadScriptEnv();
  const skipBuild = process.argv.includes("--skip-build");

  if (!skipBuild) {
    run("bash", ["scripts/anchor-build.sh"]);
  } else {
    console.log("deploy: --skip-build, using the existing target/deploy build");
  }

  // Fix #19: only safe to import the generated SDK (and `lib/client.js`, which imports it
  // too) after the build step above has had a chance to run.
  const { createConnection, assertGenesisHash } = await import("./lib/client.js");
  const { PROGRAM_ID } = await import("@meridian/sdk");

  const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
  const adminPath = resolveAdminKeypairPath(env.adminKeypairPath, true);
  console.log(`deploy: admin wallet ${admin.publicKey.toBase58()} (${adminPath})`);

  const connectionForTopUp = createConnection(env.solanaRpcUrl);
  await assertGenesisHash(connectionForTopUp, env.cluster);
  await ensureLocalnetDeployFunds(connectionForTopUp, admin.publicKey, env.cluster);

  const deployOutput = run("anchor", [
    "deploy",
    "--provider.cluster",
    env.solanaRpcUrl,
    "--provider.wallet",
    adminPath,
  ]);

  const deployedProgramId = parseProgramIdFromDeployOutput(deployOutput);
  const expectedProgramId = PROGRAM_ID.toBase58();
  if (deployedProgramId !== expectedProgramId) {
    throw new Error(
      `deploy: anchor deploy reported program id ${deployedProgramId}, but the SDK (anchor keys sync) says ${expectedProgramId}`,
    );
  }

  const connection = createConnection(env.solanaRpcUrl);
  const accountInfo = await connection.getAccountInfo(new PublicKey(deployedProgramId), "confirmed");
  if (!accountInfo) {
    throw new Error(`deploy: no on-chain account found at ${deployedProgramId} after deploy`);
  }
  if (!accountInfo.executable) {
    throw new Error(`deploy: on-chain account ${deployedProgramId} is not marked executable`);
  }

  console.log("");
  console.log("deploy: summary");
  console.log(`  cluster:     ${env.cluster} (${env.solanaRpcUrl})`);
  console.log(`  program id:  ${deployedProgramId}`);
  console.log(`  executable:  ${accountInfo.executable}`);
  console.log(`  data bytes:  ${accountInfo.data.length}`);
  console.log(`  admin:       ${admin.publicKey.toBase58()}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
