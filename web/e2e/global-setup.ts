/**
 * Playwright `globalSetup` (tasks.md T066/T075/T080): seeds the chain fixture
 * once, before any spec file runs, by calling `seed.ts`'s `runSeed()`
 * directly -- a plain TypeScript import/call, not a subprocess, since this
 * file and `seed.ts` are both TypeScript already and Playwright's own
 * runner loads this file with full Node/TS support.
 *
 * Deliberately a chain mutation (not just a read of a pre-existing seed
 * file): `make test-web` only takes the validator up through
 * `deploy`/`init-config` before starting `next dev` and Playwright, so by
 * the time this runs the chain has a program and a `Config` but no markets
 * yet. The resulting `/tmp/meridian-e2e-seed.json` is what every spec file
 * reads back for market pubkeys and the keypairs to drive as the browser
 * wallet.
 */

import { runSeed } from "./seed";

export default async function globalSetup(): Promise<void> {
  await runSeed();
}
