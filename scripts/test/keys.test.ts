import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  loadKeypair,
  resolveAdminKeypair,
  resolveAdminKeypairPath,
  resolveKeypair,
  writableKeysDir,
  writeKeypair,
} from "../lib/keys.js";

// Fix #20/#22: `writableKeysDir()` always resolves to the real repo-root `keys/` directory
// (it is resolved from this module's own file location, not an injectable path), so these
// tests use throwaway basenames under it and clean up afterward rather than mocking the
// filesystem.
const FIXTURE_NAMES: string[] = [];

function fixturePath(name: string): string {
  FIXTURE_NAMES.push(name);
  return join(writableKeysDir(), name);
}

afterEach(() => {
  for (const name of FIXTURE_NAMES.splice(0)) {
    rmSync(join(writableKeysDir(), name), { force: true });
  }
});

describe("writableKeysDir", () => {
  it("resolves to a repo-relative keys/ directory (not /run/keys)", () => {
    expect(writableKeysDir().endsWith("/keys")).toBe(true);
    expect(writableKeysDir()).not.toContain("/run/keys");
  });
});

describe("writeKeypair (fix #22)", () => {
  it("creates the key file with mode 0600 and the directory with mode 0700", () => {
    const path = fixturePath("fixture-mode.json");
    writeKeypair(path, Keypair.generate());

    const fileMode = statSync(path).mode & 0o777;
    expect(fileMode).toBe(0o600);

    const dirMode = statSync(writableKeysDir()).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });
});

describe("loadKeypair (fix #21)", () => {
  it("on JSON parse failure, reports the path and a fixed message, never parser text or file contents", () => {
    const path = fixturePath("fixture-corrupt.json");
    mkdirSync(writableKeysDir(), { recursive: true });
    writeFileSync(path, "{ not valid json, super-secret-marker-xyz");

    let thrown: Error | undefined;
    try {
      loadKeypair(path);
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toBe(`loadKeypair: keypair file at "${path}" is not valid JSON`);
    expect(thrown!.message).not.toContain("super-secret-marker-xyz");
  });
});

// `compose.yml` bind-mounts `./keys` at `/run/keys` read-only, so inside the real container
// `/run/keys/<name>.json` and `<repo>/keys/<name>.json` are the *same* underlying file --
// writing one makes the other "exist" too. These tests instead configure a path under a
// directory that is never written to (`NONEXISTENT_CONFIGURED_DIR`), so a successful write can
// only have landed under `writableKeysDir()`, proving creation never targets the configured
// path's own directory (which is `/run/keys` in production).
const NONEXISTENT_CONFIGURED_DIR = "/tmp/meridian-keys-test-configured-dir-does-not-exist";

describe("resolveAdminKeypair / resolveKeypair creation target (fix #20)", () => {
  it("resolveAdminKeypair creates a missing key under keys/, never at the configured path's directory", () => {
    const configuredPath = join(NONEXISTENT_CONFIGURED_DIR, "fixture-admin-does-not-exist.json");
    fixturePath("fixture-admin-does-not-exist.json");

    expect(existsSync(configuredPath)).toBe(false);

    const kp = resolveAdminKeypair(configuredPath, { createIfMissing: true, allowCliFallback: false });

    expect(existsSync(configuredPath)).toBe(false);
    const created = join(writableKeysDir(), "fixture-admin-does-not-exist.json");
    expect(existsSync(created)).toBe(true);
    expect(loadKeypair(created).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("resolveKeypair creates a missing key under keys/, never at the configured path's directory", () => {
    const configuredPath = join(NONEXISTENT_CONFIGURED_DIR, "fixture-publisher-does-not-exist.json");
    fixturePath("fixture-publisher-does-not-exist.json");

    const kp = resolveKeypair(configuredPath, { createIfMissing: true });

    expect(existsSync(configuredPath)).toBe(false);
    const created = join(writableKeysDir(), "fixture-publisher-does-not-exist.json");
    expect(existsSync(created)).toBe(true);
    expect(loadKeypair(created).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("resolveAdminKeypairPath finds a key already created under keys/ as the last fallback", () => {
    const name = "fixture-admin-path-fallback.json";
    const created = fixturePath(name);
    writeKeypair(created, Keypair.generate());

    const resolved = resolveAdminKeypairPath(join(NONEXISTENT_CONFIGURED_DIR, name), false);
    expect(resolved).toBe(created);
  });

  it("without --create-keys, throws rather than writing anywhere", () => {
    const name = "fixture-admin-no-create.json";
    fixturePath(name);
    expect(() =>
      resolveAdminKeypair(join(NONEXISTENT_CONFIGURED_DIR, name), { createIfMissing: false, allowCliFallback: false }),
    ).toThrow(/--create-keys was not passed/);
    expect(existsSync(join(writableKeysDir(), name))).toBe(false);
  });
});
