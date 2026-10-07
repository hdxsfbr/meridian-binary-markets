/**
 * Preflight balance checks for `scripts/lifecycle.ts` (Wave 6 review fix
 * #8): resolves every key this run needs (admin, publisher, demo users A/B)
 * and checks their balances *before* a single `create_market` is sent --
 * previously the admin paid for the entire market ladder before the demo
 * users' (and the publisher's) balances were ever looked at, so a run could
 * burn through market creation only to fail funding a wallet right before
 * trading, or never check the publisher at all until `mock_write_price`
 * failed at settlement.
 *
 * Localnet: shortfalls are funded directly (`requestAirdrop`). Devnet: every
 * shortfall is collected and printed -- address and exact amount still
 * needed -- then this throws once, so the caller exits 1 before creating
 * anything.
 */

import { LAMPORTS_PER_SOL, type Connection, type Keypair } from "@solana/web3.js";

/** `settle_market`'s (and the probe's) `mock_write_price` payer must clear this floor. */
export const PUBLISHER_MIN_SOL_LAMPORTS = BigInt(Math.round(0.05 * LAMPORTS_PER_SOL));

/**
 * Flat buffer added on top of the day's rent when sizing the admin's required SOL: this
 * run sends on the order of 150+ further transactions beyond market/book creation
 * (`mock_write_price` per ticker, `settle_market` per market), each paying a small network
 * fee the rent total alone doesn't account for.
 */
export const ADMIN_FEE_BUFFER_LAMPORTS = BigInt(Math.round(0.5 * LAMPORTS_PER_SOL));

function solStr(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
}

async function airdropTo(connection: Connection, keypair: Keypair, lamports: bigint): Promise<void> {
  const sig = await connection.requestAirdrop(keypair.publicKey, Number(lamports));
  const latest = await connection.getLatestBlockhash("confirmed");
  const result = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  if (result.value.err) {
    throw new Error(`preflight: airdrop to ${keypair.publicKey.toBase58()} failed: ${JSON.stringify(result.value.err)}`);
  }
}

export interface PrincipalSolRequirement {
  label: string;
  keypair: Keypair;
  requiredLamports: bigint;
}

/**
 * Checks (and, on localnet, tops up) every principal's SOL balance against
 * its requirement. On devnet, collects every shortfall and throws once with
 * the full list -- never proceeds with even one underfunded principal.
 */
export async function preflightSol(
  connection: Connection,
  cluster: "localnet" | "devnet",
  principals: PrincipalSolRequirement[],
  log: (line: string) => void,
): Promise<void> {
  const missing: string[] = [];
  for (const p of principals) {
    const balance = BigInt(await connection.getBalance(p.keypair.publicKey, "confirmed"));
    const short = p.requiredLamports - balance;
    if (short <= 0n) {
      log(`${p.label} ${p.keypair.publicKey.toBase58()}: ${solStr(balance)} SOL (>= required ${solStr(p.requiredLamports)})`);
      continue;
    }
    if (cluster === "localnet") {
      await airdropTo(connection, p.keypair, short);
      log(
        `${p.label} ${p.keypair.publicKey.toBase58()}: airdropped ${solStr(short)} SOL (had ${solStr(balance)}, now >= required ${solStr(p.requiredLamports)})`,
      );
    } else {
      missing.push(
        `  ${p.label} ${p.keypair.publicKey.toBase58()}: has ${solStr(balance)} SOL, needs >= ${solStr(p.requiredLamports)} SOL (short ${solStr(short)} SOL)`,
      );
    }
  }
  if (missing.length > 0) {
    console.log("lifecycle: devnet principals are underfunded. Fund manually (SOL faucet) and re-run:");
    for (const line of missing) console.log(line);
    throw new Error("lifecycle: devnet principals underfunded; see funding instructions above");
  }
}
