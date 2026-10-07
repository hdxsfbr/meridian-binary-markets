/**
 * Fund an arbitrary wallet on LOCALNET with SOL and test USDC so a person can
 * trade in the browser. Localnet only: the test USDC mint's authority is the
 * admin key, which does not exist on devnet (Circle's mint is used there).
 *
 *   pnpm --filter @meridian/scripts run fund-wallet -- <pubkey> [--sol 2] [--usdc 100]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadScriptEnv } from "./lib/env.js";
import { resolveAdminKeypair, resolveKeypair } from "./lib/keys.js";
import { LifecycleChain } from "./lib/lifecycle/chain.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) throw new Error("usage: fund-wallet <pubkey> [--sol N] [--usdc N]");
  const flag = (name: string, dflt: number): number => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
  };
  const sol = flag("--sol", 2);
  const usdc = flag("--usdc", 100);
  const env = loadScriptEnv();
  if (env.cluster !== "localnet") throw new Error("fund-wallet is localnet only (devnet uses the public faucets)");
  const owner = new PublicKey(target);
  const connection = new Connection(env.solanaRpcUrl, "confirmed");
  const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
  const publisher = resolveKeypair(env.publisherKeypairPath, { createIfMissing: false });
  const bootstrap = new LifecycleChain(connection, admin, publisher, PublicKey.default);
  const config = await bootstrap.fetchConfig();
  if (!config) throw new Error("Config not initialised; run init-config first");
  const chain = new LifecycleChain(connection, admin, publisher, config.usdcMint);

  const sig = await connection.requestAirdrop(owner, Math.round(sol * 1e9));
  const bh = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  const ata = await chain.usdcAta(owner);
  await chain.fundUsdc(ata, BigInt(Math.round(usdc * 1e6)));
  const bal = await connection.getBalance(owner, "confirmed");
  const ubal = await chain.getTokenBalance(ata);
  console.log(`funded ${owner.toBase58()}: ${bal / 1e9} SOL, ${Number(ubal) / 1e6} USDC (ata ${ata.toBase58()})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
