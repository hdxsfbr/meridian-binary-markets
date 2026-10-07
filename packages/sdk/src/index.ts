import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID_BASE58 } from "./program-id";

/**
 * The Meridian program id. Sourced from `./program-id.ts`, a file generated
 * by `scripts/anchor-build.sh` from the synced keypair/Anchor.toml/declare_id!
 * so it can never drift from the on-chain id.
 */
export const PROGRAM_ID = new PublicKey(PROGRAM_ID_BASE58);

/**
 * Reads the Anchor-generated IDL produced by `anchor build` at
 * `target/idl/meridian.json`. Throws if the program has not been built yet.
 */
export function loadIdl(): Record<string, unknown> {
  const idlPath = join(__dirname, "..", "..", "..", "target", "idl", "meridian.json");
  const raw = readFileSync(idlPath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

export * from "./types";
export * from "./pda";
export * from "./strikes";
