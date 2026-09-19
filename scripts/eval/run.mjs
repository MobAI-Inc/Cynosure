// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.argv[2]),
  phase = process.argv[3];
if (!root || !["learn", "heldout-1", "heldout-2"].includes(phase))
  throw new Error("Usage: run.mjs directory phase [promptfoo flags]");
const args = [
  "--env-file-if-exists=.env",
  resolve("node_modules/promptfoo/dist/src/entrypoint.js"),
  "eval",
  "-c",
  `${root}/${phase}.config.json`,
  "--no-cache",
  "--no-share",
  "--no-table",
  "--no-progress-bar",
  "-o",
  `${root}/${phase}.json`,
  ...process.argv.slice(4),
];
const p = spawn(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    CYNOSURE_EVAL_DIR: root,
    CYNOSURE_EVAL_PHASE: phase,
    PROMPTFOO_DISABLE_TELEMETRY: "1",
    PROMPTFOO_CONFIG_DIR: resolve(".cynosure/promptfoo"),
  },
});
p.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
