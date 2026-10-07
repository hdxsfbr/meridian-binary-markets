/**
 * Keypair loading/creation for the operational scripts. Mirrors
 * `services/automation/src/keys.ts`'s strict loader (Solana CLI-style JSON
 * array of 64 secret-key bytes), and adds the two behaviors the automation
 * service never needs: falling back to the host Solana CLI's default
 * wallet when `ADMIN_KEYPAIR_PATH` is unset and nothing is mounted at
 * `/run/keys/admin.json`, and creating fresh keypairs on disk when asked
 * (`--create-keys`), which is only ever safe on `localnet`.
 *
 * Fix #20: `compose.yml` mounts `./keys` at `/run/keys` read-only
 * (`ADMIN_KEYPAIR_PATH`/`PUBLISHER_KEYPAIR_PATH` default there) -- a key can
 * be read from it, but never written to it. Creation always targets the
 * writable, gitignored repo-relative `keys/` directory instead (resolved
 * from this file's own location via `import.meta.url`, not
 * `process.cwd()`), using the configured path's basename
 * (`keys/<name>.json`). Reads still follow the full fallback chain:
 * `path` (typically `/run/keys/<name>.json`) -> for the admin key only, the
 * Solana CLI's default wallet -> `keys/<name>.json`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Keypair } from "@solana/web3.js";

/** Default location of the Solana CLI's own wallet, used as the last-resort fallback. */
export function defaultCliKeypairPath(): string {
  return join(homedir(), ".config", "solana", "id.json");
}

/**
 * The writable, gitignored `keys/` directory at the repo root (`.gitignore`:
 * `keys/`), resolved from this file's own location rather than
 * `process.cwd()` (which `pnpm --filter` sets to the `scripts/` package
 * directory, not the repo root). This is the only directory `--create-keys`
 * ever writes to -- never `/run/keys`, which `compose.yml` mounts read-only.
 */
export function writableKeysDir(): string {
  const libDir = dirname(fileURLToPath(import.meta.url)); // scripts/lib
  return join(libDir, "..", "..", "keys");
}

/** The writable fallback path for the keypair nominally configured at `path`. */
function writableKeyPath(path: string): string {
  return join(writableKeysDir(), basename(path));
}

function isByteValue(n: unknown): boolean {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255;
}

/**
 * Reads a Solana CLI-style keypair file (a JSON array of 64 bytes) at
 * `path` and returns the corresponding `Keypair`. Throws with the path in
 * the message on any read/parse/shape failure.
 *
 * Fix #21: a JSON parse failure reports only the path and a fixed message --
 * never the underlying parser error text (which can echo back a snippet of
 * the file's contents) or the file contents themselves.
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
  } catch {
    throw new Error(`loadKeypair: keypair file at "${path}" is not valid JSON`);
  }

  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every(isByteValue)) {
    throw new Error(
      `loadKeypair: keypair file at "${path}" must be a JSON array of 64 integers, each 0-255`,
    );
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

/**
 * Writes `keypair` to `path` (Solana CLI JSON array format), creating
 * parent directories. Fix #22: the parent directory is always left at mode
 * `0700` and the key file at mode `0600` -- a keypair file is a bearer
 * secret, and the default `umask`-controlled modes are not private enough.
 */
export function writeKeypair(path: string, keypair: Keypair): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
}

export interface ResolveKeypairOptions {
  /** Create a fresh keypair under `keys/` if nothing is found anywhere in the read chain. Only ever safe off mainnet. */
  createIfMissing: boolean;
  /** Whether a missing admin keypair may fall back to the Solana CLI's default wallet path. */
  allowCliFallback?: boolean;
}

/**
 * Resolves which path on disk holds the admin keypair, without reading it:
 * `path` if it exists, else the Solana CLI default wallet path if that
 * exists and `allowCliFallback` is set, else the writable `keys/<name>.json`
 * fallback if that exists. Throws otherwise. Used where a filesystem path is
 * what's needed (e.g. `anchor deploy --provider.wallet`), as opposed to
 * `resolveAdminKeypair`, which returns the loaded `Keypair`.
 */
export function resolveAdminKeypairPath(path: string, allowCliFallback: boolean): string {
  if (existsSync(path)) {
    return path;
  }
  if (allowCliFallback) {
    const cliPath = defaultCliKeypairPath();
    if (existsSync(cliPath)) {
      return cliPath;
    }
  }
  const fallback = writableKeyPath(path);
  if (existsSync(fallback)) {
    return fallback;
  }
  throw new Error(
    `resolveAdminKeypairPath: no keypair at "${path}"${
      allowCliFallback ? ` or "${defaultCliKeypairPath()}"` : ""
    } or "${fallback}"`,
  );
}

/**
 * Resolves the admin keypair: `path` if it exists, else the Solana CLI's
 * default wallet (`~/.config/solana/id.json`) if that exists and
 * `allowCliFallback` is set, else the writable `keys/<name>.json` fallback
 * if that exists, else (if `createIfMissing`) a freshly generated keypair
 * written to `keys/<name>.json` (never to `path` itself, which may be the
 * read-only `/run/keys` mount). Throws otherwise.
 */
export function resolveAdminKeypair(path: string, opts: ResolveKeypairOptions): Keypair {
  if (existsSync(path)) {
    return loadKeypair(path);
  }

  if (opts.allowCliFallback) {
    const cliPath = defaultCliKeypairPath();
    if (existsSync(cliPath)) {
      return loadKeypair(cliPath);
    }
  }

  const fallback = writableKeyPath(path);
  if (existsSync(fallback)) {
    return loadKeypair(fallback);
  }

  if (opts.createIfMissing) {
    const kp = Keypair.generate();
    writeKeypair(fallback, kp);
    console.log(`resolveAdminKeypair: created admin keypair at "${fallback}"`);
    return kp;
  }

  throw new Error(
    `resolveAdminKeypair: no keypair at "${path}"${
      opts.allowCliFallback ? ` or "${defaultCliKeypairPath()}"` : ""
    } or "${fallback}", and --create-keys was not passed`,
  );
}

/**
 * Resolves a non-admin keypair (e.g. the publisher) at `path`: loads it if
 * present, else loads the writable `keys/<name>.json` fallback if present,
 * else (if `createIfMissing`) generates and writes a fresh one to
 * `keys/<name>.json` (never to `path` itself, which may be the read-only
 * `/run/keys` mount).
 */
export function resolveKeypair(path: string, opts: { createIfMissing: boolean }): Keypair {
  if (existsSync(path)) {
    return loadKeypair(path);
  }

  const fallback = writableKeyPath(path);
  if (existsSync(fallback)) {
    return loadKeypair(fallback);
  }

  if (opts.createIfMissing) {
    const kp = Keypair.generate();
    writeKeypair(fallback, kp);
    console.log(`resolveKeypair: created keypair at "${fallback}"`);
    return kp;
  }
  throw new Error(`resolveKeypair: no keypair at "${path}" or "${fallback}", and --create-keys was not passed`);
}
