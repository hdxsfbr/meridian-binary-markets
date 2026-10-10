import { fileURLToPath } from "node:url";
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
  resolve: {
    // Mirrors tsconfig.json's `paths` (`"@/*": ["./src/*"]`) so a component
    // test can import its own module the same way the app code does,
    // instead of every test needing a relative `./`/`../` import.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
  },
});
