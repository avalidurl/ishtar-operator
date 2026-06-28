import { defineConfig } from "vitest/config";

// Pure-helper unit tests run in Node (WebCrypto is global in Node 20+). The DO /
// Workflow runtime is verified separately via `wrangler deploy --dry-run`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
