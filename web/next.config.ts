import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `make test-web` drives `next dev` over `http://127.0.0.1:3000` (Playwright's
  // baseURL, tasks.md T066/T075/T080): Next's dev server otherwise blocks
  // `127.0.0.1` as a "cross-origin" HMR/dev-resource request (distinct from
  // `localhost`, which is allowed by default), which breaks the dev HMR
  // websocket handshake and, with it, client-side hydration entirely --
  // every button on the page renders from SSR but no React event handler
  // ever attaches. Harmless outside dev (this option is a no-op in production
  // builds).
  allowedDevOrigins: ["127.0.0.1", ...(process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)],
};

export default nextConfig;
