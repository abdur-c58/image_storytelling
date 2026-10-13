import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The e2e script uses its own build dir so it can run next to a normal `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    agentFeedback: true,
  },
  // PGlite ships a WASM Postgres; keep it out of the bundle so it loads from node_modules.
  serverExternalPackages: ["@electric-sql/pglite", "sharp"],
  outputFileTracingIncludes: {
    "/api/bot/runbook": ["./bot/RUNBOOK.md"],
    "/new": ["./fixtures/*.json"],
    "/*": ["./drizzle/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
