import { defineConfig } from "vitest/config";

/**
 * Vitest's default `include` glob (`**\/*.{test,spec}.?(c|m)[jt]sx?`) would
 * otherwise also pick up `web/e2e/*.spec.ts` -- those are Playwright specs
 * (a different `test()` global, browser-only fixtures) and must never run
 * under Vitest. Excluding the whole `e2e/` directory keeps `pnpm --filter
 * @meridian/web run test` (Vitest) and `run test:e2e` (Playwright) cleanly
 * partitioned by directory rather than by a naming convention either tool
 * could silently violate later.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
  },
});
