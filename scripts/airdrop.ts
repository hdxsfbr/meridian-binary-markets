#!/usr/bin/env -S node --
/**
 * `make` target / `pnpm --filter @meridian/scripts run airdrop`.
 *
 * Requests 2 SOL (`LAMPORTS_PER_SOL * 2`) for the admin keypair (or
 * `--to <pubkey>` if given). On `localnet` this always succeeds (a local
 * validator airdrops freely); on `devnet` the faucet rate-limits per
 * address/IP and a failure here is expected and handled with a clear
 * pointer to `faucet.solana.com` as the manual fallback (DECISIONS §6:
 * Circle's USDC faucet is separate and unaffected).
 *
 * `--create-keys`: generate the admin/publisher keypairs on disk first if
 * they do not exist yet (only ever done on `localnet`; refused on
 * `devnet`, where losing/overwriting a funded key is a real cost).
 */

import { fileURLToPath } from "node:url";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { loadScriptEnv } from "./lib/env.js";
import { assertGenesisHash, createConnection } from "./lib/client.js";
import { resolveAdminKeypair, resolveKeypair } from "./lib/keys.js";

export const AIRDROP_LAMPORTS = 2 * LAMPORTS_PER_SOL;

function parseToFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf("--to");
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value) {
    throw new Error("airdrop: --to requires a public key argument");
  }
  return value;
}

/** True if `err` looks like Solana's devnet faucet rate limit response. */
export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /rate.?limit|429|airdrop request limit/i.test(message);
}

async function main(): Promise<void> {
  const env = loadScriptEnv();
  const createKeys = process.argv.includes("--create-keys");
  const toArg = parseToFlag(process.argv);

  if (createKeys && env.cluster !== "localnet") {
    throw new Error("airdrop: --create-keys is only allowed on CLUSTER=localnet");
  }

  const connection = createConnection(env.solanaRpcUrl);
  await assertGenesisHash(connection, env.cluster);

  let recipient: PublicKey;
  if (toArg) {
    recipient = new PublicKey(toArg);
  } else {
    const admin = resolveAdminKeypair(env.adminKeypairPath, {
      createIfMissing: createKeys,
      allowCliFallback: !createKeys,
    });
    if (createKeys) {
      // Also make sure the publisher keypair exists, since the rest of the
      // lifecycle (init-config) needs it and --create-keys is the one flag
      // that signals "bootstrap a fresh localnet identity set".
      resolveKeypair(env.publisherKeypairPath, { createIfMissing: true });
    }
    recipient = admin.publicKey;
  }

  console.log(`airdrop: requesting ${AIRDROP_LAMPORTS / LAMPORTS_PER_SOL} SOL for ${recipient.toBase58()} on ${env.cluster}`);

  try {
    const signature = await connection.requestAirdrop(recipient, AIRDROP_LAMPORTS);
    const latest = await connection.getLatestBlockhash("confirmed");
    const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (result.value.err) {
      throw new Error(`airdrop transaction failed: ${JSON.stringify(result.value.err)}`);
    }
    const balance = await connection.getBalance(recipient, "confirmed");
    console.log(`airdrop: confirmed (${signature}); balance is now ${balance / LAMPORTS_PER_SOL} SOL`);
  } catch (err) {
    if (env.cluster === "devnet" && isRateLimitError(err)) {
      console.error(
        `airdrop: devnet faucet rate-limited this request. Fall back to https://faucet.solana.com ` +
          `and paste ${recipient.toBase58()} there, or retry later.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
