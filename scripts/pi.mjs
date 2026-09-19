// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cwd = resolve(process.argv[2] ?? ".");
const id = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
const local = join(root, ".cynosure", "pi", id);
mkdirSync(local, { recursive: true, mode: 0o700 });
const child = spawn(
  "pi",
  [
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    join(root, "integrations/pi/index.ts"),
    "--provider",
    "cynosure",
    "--model",
    "auto",
    ...process.argv.slice(3),
  ],
  {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_DIR: join(local, "agent"),
      CYNOSURE_DB: process.env.CYNOSURE_DB ?? join(local, "experience.sqlite"),
      CYNOSURE_SCOPE: process.env.CYNOSURE_SCOPE ?? cwd,
    },
  },
);
child.on("error", () => {
  console.error("Cannot start the installed Pi executable.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
