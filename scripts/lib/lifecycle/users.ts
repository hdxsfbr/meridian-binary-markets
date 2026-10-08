/**
 * Demo user bootstrap for `scripts/lifecycle.ts` (tasks.md T086, step 5):
 * two users, A (maker) and B (taker), each needing a funded SOL balance
 * (for transaction fees/rent) and a funded USDC ATA to trade with.
 *
 * On localnet: SOL via `connection.requestAirdrop` (always succeeds
 * against a local validator), USDC via `LifecycleChain.fundUsdc` (the test
 * mint's authority is the admin keypair, set up by `init-config.ts`/this
 * script's `ensureConfig` step). On devnet: SOL/USDC funding is a manual,
 * human step (Circle USDC has no instant faucet this script can drive) --
 * `fundUsersOrInstruct` prints the addresses and required amounts and
 * throws rather than silently proceeding with empty wallets.
 */

import { Keypair, LAMPORTS_PER_SOL, type Connection } from "@solana/web3.js";
import type { LifecycleChain } from "./chain.js";
import { resolveKeypair, writeKeypair, writableKeysDir } from "../keys.js";
import { join } from "node:path";

export interface DemoUser {
  label: "A" | "B";
  keypair: Keypair;
}

const DEMO_USER_SOL = 2 * LAMPORTS_PER_SOL;

/** Resolves (or creates, localnet only) the two demo user keypairs at `keys/user-a.json`/`keys/user-b.json`. */
export function resolveDemoUsers(cluster: "localnet" | "devnet"): { userA: DemoUser; userB: DemoUser } {
  const dir = writableKeysDir();
  const pathA = join(dir, "user-a.json");
  const pathB = join(dir, "user-b.json");
  const createIfMissing = cluster === "localnet";
  const userA: DemoUser = { label: "A", keypair: resolveKeypair(pathA, { createIfMissing }) };
  const userB: DemoUser = { label: "B", keypair: resolveKeypair(pathB, { createIfMissing }) };
  return { userA, userB };
}

async function airdropSol(connection: Connection, pubkey: Keypair["publicKey"], lamports: number): Promise<void> {
  const balance = await connection.getBalance(pubkey, "confirmed");
  if (balance >= lamports) return;
  const sig = await connection.requestAirdrop(pubkey, lamports - balance);
  const latest = await connection.getLatestBlockhash("confirmed");
  const result = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  if (result.value.err) {
    throw new Error(`airdropSol: airdrop to ${pubkey.toBase58()} failed: ${JSON.stringify(result.value.err)}`);
  }
}

/**
 * Funds A and B with SOL and USDC on localnet, or prints manual funding
 * instructions and throws on devnet if either balance is insufficient
 * (brief step 5: "on devnet print instructions to fund with Circle USDC
 * and abort if balances are insufficient").
 */
export async function fundDemoUsers(
  connection: Connection,
  cluster: "localnet" | "devnet",
  chain: LifecycleChain,
  userA: DemoUser,
  userB: DemoUser,
  usdcAMicro: bigint,
  usdcBMicro: bigint = usdcAMicro,
): Promise<{ userAUsdcAta: Awaited<ReturnType<LifecycleChain["usdcAta"]>>; userBUsdcAta: Awaited<ReturnType<LifecycleChain["usdcAta"]>> }> {
  if (cluster === "devnet") {
    const [balA, balB] = await Promise.all([
      connection.getBalance(userA.keypair.publicKey, "confirmed"),
      connection.getBalance(userB.keypair.publicKey, "confirmed"),
    ]);
    const userAUsdcAta = await chain.usdcAta(userA.keypair.publicKey).catch(() => null);
    const userBUsdcAta = await chain.usdcAta(userB.keypair.publicKey).catch(() => null);
    const usdcBalA = userAUsdcAta ? await chain.getTokenBalance(userAUsdcAta) : 0n;
    const usdcBalB = userBUsdcAta ? await chain.getTokenBalance(userBUsdcAta) : 0n;
    const minSol = LAMPORTS_PER_SOL / 10; // 0.1 SOL floor for fees
    if (balA < minSol || balB < minSol || usdcBalA < usdcAMicro || usdcBalB < usdcBMicro) {
      console.log("lifecycle: devnet demo users are underfunded. Fund manually and re-run:");
      console.log(`  A: ${userA.keypair.publicKey.toBase58()} (SOL via faucet.solana.com; USDC via Circle devnet faucet)`);
      console.log(`  B: ${userB.keypair.publicKey.toBase58()} (SOL via faucet.solana.com; USDC via Circle devnet faucet)`);
      console.log(
        `  need A >= ${Number(usdcAMicro) / 1_000_000} USDC, B >= ${Number(usdcBMicro) / 1_000_000} USDC, and >= 0.1 SOL each`,
      );
      throw new Error("lifecycle: devnet demo users underfunded; see funding instructions above");
    }
    return { userAUsdcAta: userAUsdcAta!, userBUsdcAta: userBUsdcAta! };
  }

  await Promise.all([
    airdropSol(connection, userA.keypair.publicKey, DEMO_USER_SOL),
    airdropSol(connection, userB.keypair.publicKey, DEMO_USER_SOL),
  ]);

  const userAUsdcAta = await chain.usdcAta(userA.keypair.publicKey);
  const userBUsdcAta = await chain.usdcAta(userB.keypair.publicKey);

  const [balA, balB] = await Promise.all([chain.getTokenBalance(userAUsdcAta), chain.getTokenBalance(userBUsdcAta)]);
  if (balA < usdcAMicro) await chain.fundUsdc(userAUsdcAta, usdcAMicro - balA);
  if (balB < usdcBMicro) await chain.fundUsdc(userBUsdcAta, usdcBMicro - balB);

  return { userAUsdcAta, userBUsdcAta };
}

// Re-export for callers that only need the directory (keeps `lifecycle.ts`'s import list small).
export { writableKeysDir, writeKeypair };
