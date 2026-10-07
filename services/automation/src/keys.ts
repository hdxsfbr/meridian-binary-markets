/**
 * Keypair loading for the automation service (contracts/oracle-provider.md
 * "Environment variables": `ADMIN_KEYPAIR_PATH` / `PUBLISHER_KEYPAIR_PATH`).
 * Keypairs are mounted read-only JSON arrays of 64 secret-key bytes (the
 * standard Solana CLI keypair file format) and never committed.
 */

import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

/**
 * Reads a Solana CLI-style keypair file (a JSON array of 64 bytes) at
 * `path` and returns the corresponding `Keypair`. Throws with the path in
 * the message on any read/parse/shape failure, since a missing or
 * malformed keypair must fail closed rather than silently produce a
 * throwaway key.
 */
export function loadKeypair(path: string): Keypair {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`loadKeypair: could not read keypair file at "${path}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadKeypair: keypair file at "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  const isByteValue = (n: unknown): boolean =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255;

  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every(isByteValue)) {
    throw new Error(
      `loadKeypair: keypair file at "${path}" must be a JSON array of 64 integers, each 0-255`,
    );
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

/** Loads the admin keypair from `ADMIN_KEYPAIR_PATH`. */
export function loadAdminKeypair(path: string): Keypair {
  return loadKeypair(path);
}

/** Loads the publisher keypair from `PUBLISHER_KEYPAIR_PATH`. */
export function loadPublisherKeypair(path: string): Keypair {
  return loadKeypair(path);
}
