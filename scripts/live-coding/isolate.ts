// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";

export default function (pi) {
  const root = realpathSync(process.cwd());
  if (process.env.CODING_TEST_FILE) {
    appendFileSync(
      process.env.CODING_TOOL_POLICY,
      `\n(deny file-write* (literal ${JSON.stringify(process.env.CODING_TEST_FILE)}))\n`,
    );
  }
  pi.on("tool_call", (event) => {
    if (!["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) return;
    const candidate = resolve(root, event.input.path ?? ".");
    let existing = candidate;
    while (!existsSync(existing)) existing = dirname(existing);
    const canonical = realpathSync(existing);
    if (
      ["read", "grep", "find", "ls"].includes(event.toolName) &&
      canonical.startsWith(`${process.env.CODING_CHECK_SCRIPTS}/`)
    )
      return;
    if (
      ["edit", "write"].includes(event.toolName) &&
      (candidate === process.env.CODING_TEST_FILE ||
        canonical === process.env.CODING_TEST_FILE ||
        candidate === `${root}/.git` ||
        candidate.includes("/.git/"))
    )
      return { block: true, reason: "Regression tests and baseline metadata are immutable." };
    const rel = relative(root, canonical);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      return { block: true, reason: "This experiment can access only its source-code copy." };
  });
  pi.registerTool({
    ...createBashTool(root, {
      exposeSessionEnvironment: false,
      operations: {
        exec(command, cwd, options) {
          if (
            /\b(npm|pnpm|yarn|bun|pip3?|uv)\s+(install|add|update|sync|exec|x)\b|\bnpx\b/.test(
              command,
            )
          )
            return Promise.reject(
              new Error("Use existing runtimes; installing dependencies is disabled."),
            );
          return new Promise((resolveRun, reject) => {
            const child = spawn(
              "/usr/bin/sandbox-exec",
              [
                "-f",
                process.env.CODING_TOOL_POLICY,
                "/bin/bash",
                "--noprofile",
                "--norc",
                "-c",
                command,
              ],
              {
                cwd,
                detached: true,
                env: {
                  PATH: process.env.PATH,
                  HOME: process.env.CODING_SCRATCH,
                  TMPDIR: process.env.CODING_SCRATCH,
                  LANG: "en_US.UTF-8",
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            const abort = () => {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
            };
            const timer = setTimeout(abort, (options.timeout ?? 90) * 1000);
            options.signal?.addEventListener("abort", abort, { once: true });
            child.stdout.on("data", options.onData);
            child.stderr.on("data", options.onData);
            child.on("error", reject);
            child.on("close", (exitCode) => {
              clearTimeout(timer);
              options.signal?.removeEventListener("abort", abort);
              resolveRun({ exitCode });
            });
          });
        },
      },
    }),
  });
}
