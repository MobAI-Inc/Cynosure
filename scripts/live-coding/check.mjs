// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [caseId, input, scratchArg] = process.argv.slice(2);
const root = resolve(input),
  scratch = resolve(scratchArg ?? ".cynosure-check");
mkdirSync(scratch, { recursive: true });
const here = dirname(new URL(import.meta.url).pathname);
const args =
  caseId === "backend-oauth-basepath"
    ? [
        "--test",
        "--test-name-pattern=OAuth|signed release ring|signed force token",
        `${root}/cloudflare/backend-ring-router/test/backend-ring-router.test.mjs`,
      ]
    : [
        "/Users/rydia/Project/mob.ai/git/moonshort-backend-cdotlock/node_modules/vitest/vitest.mjs",
        "run",
        "--configLoader",
        "native",
        "--config",
        `${here}/vitest.config.mjs`,
      ];
const child = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: "inherit",
  timeout: 90000,
  env: {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    TMPDIR: scratch,
    HOME: scratch,
    CODING_CASE: caseId,
    CODING_COPY: root,
    CODING_SCRATCH: scratch,
  },
});
process.exitCode = child.status ?? 124;
