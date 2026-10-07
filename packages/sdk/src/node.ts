/**
 * Node-only SDK helpers. Deliberately kept out of `index.ts` (the browser-safe
 * barrel): this file imports `node:fs`/`node:path`, which breaks client
 * bundlers (Next.js/webpack) if pulled in transitively. Import from
 * `@meridian/sdk/node` explicitly wherever `loadIdl` is needed (tooling,
 * scripts, the automation service), never from a browser bundle.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Reads the Anchor-generated IDL produced by `anchor build` at
 * `target/idl/meridian.json`. Throws if the program has not been built yet.
 */
export function loadIdl(): Record<string, unknown> {
  const idlPath = join(__dirname, "..", "..", "..", "target", "idl", "meridian.json");
  const raw = readFileSync(idlPath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}
