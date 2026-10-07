/**
 * Playwright `globalTeardown` (tasks.md T066/T075/T080): removes the
 * fixture directory `seed.ts`'s `runSeed()` wrote in `globalSetup`
 * (`web/e2e/global-setup.ts`). That file holds disposable-but-real maker/
 * taker/admin secret keys (see `seed.ts`'s doc comment), so it must not
 * outlive the suite run.
 */

import { removeSeedFixture } from "./seed";

export default async function globalTeardown(): Promise<void> {
  removeSeedFixture();
}
