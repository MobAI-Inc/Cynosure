// Use the already installed project runner. No node_modules copies or installs.
import path from "node:path";

const source = process.env.CODING_COPY;
const here = path.dirname(new URL(import.meta.url).pathname);
export default {
  root: source,
  cacheDir: path.join(process.env.CODING_SCRATCH, "vite-cache"),
  resolve: {
    alias: {
      "@": source,
      cc: path.join(here, "cc-stub.ts"),
      vitest:
        "/Users/rydia/Project/mob.ai/git/moonshort-backend-cdotlock/node_modules/vitest/dist/index.js",
    },
  },
  test: {
    environment: "node",
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    include: process.env.CODING_CASE.startsWith("cocos-")
      ? ["__cynosure.test.ts"]
      : ["__tests__/lib/attribute-slots.test.ts"],
    testTimeout: 10000,
    globals: false,
    reporters: ["default"],
  },
};
