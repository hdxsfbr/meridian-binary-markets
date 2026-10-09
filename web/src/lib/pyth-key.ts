/**
 * The Pyth Pro API key, shared by every server-side route that proxies
 * Pyth (`/api/prices`, `/api/price-history`) so the key never reaches the
 * browser: `PYTH_API_KEY`, or the file at `PYTH_API_KEY_FILE` (default
 * `/run/keys/pyth_api_key`, the container's read-only key mount).
 */

import { readFileSync } from "node:fs";

export function pythApiKey(): string | undefined {
  const fromEnv = process.env.PYTH_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const keyFile = process.env.PYTH_API_KEY_FILE ?? "/run/keys/pyth_api_key";
  try {
    // Runtime-only read of a mounted secret; the bundler must not trace it.
    return readFileSync(/* turbopackIgnore: true */ keyFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
