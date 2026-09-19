// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toolPolicy } from "./policy.mjs";

const source = resolve("."),
  root = resolve(process.argv[2]);
const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8"));
const output = join(root, "preflight-v3");
const records = [];
for (const item of cases)
  for (const version of ["base", "fix"]) {
    const dir = join(output, item.id, version),
      work = join(dir, "code"),
      scratch = join(dir, "scratch");
    mkdirSync(dir, { recursive: true });
    cpSync(join(root, "snapshots", item.id, version), work, { recursive: true });
    if (item.id.startsWith("cocos-"))
      cpSync(
        join(source, "scripts/live-coding/cocos-regressions.test.ts"),
        join(work, "__cynosure.test.ts"),
      );
    mkdirSync(scratch, { recursive: true });
    const file = join(dir, "tools.sb"),
      testFile = join(work, item.test ?? "__cynosure.test.ts");
    writeFileSync(
      file,
      toolPolicy(
        source,
        [work, scratch, join(source, "scripts/live-coding")],
        [work, scratch],
        [testFile, join(work, ".git")],
      ),
    );
    const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch };
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        file,
        realpathSync(process.execPath),
        join(source, "scripts/live-coding/check.mjs"),
        item.id,
        work,
        scratch,
      ],
      { cwd: work, env, encoding: "utf8", timeout: 90000 },
    );
    const log = (result.stdout ?? "") + (result.stderr ?? "");
    writeFileSync(join(dir, "check.log"), log);
    const probes = [
      [
        "temp-copy",
        "/bin/cat",
        "/private/tmp/remix-audit/worker-context/cloudflare/backend-ring-router/src/index.mjs",
      ],
      [
        "volume-alias",
        "/bin/cat",
        "/System/Volumes/Data/private/tmp/ultra-prod-20260916/moonshort-release-router-module.js",
      ],
      ["original", "/bin/cat", join(item.repo, item.targets[0])],
      ["fixed-reference", "/bin/cat", join(root, "snapshots", item.id, "fix", item.targets[0])],
      ["test-write", "/bin/bash", "-c", `printf tamper >> '${testFile}'`],
      [
        "network",
        realpathSync(process.execPath),
        "--input-type=module",
        "-e",
        "import net from 'node:net'; net.connect({host:'127.0.0.1',port:65530}).on('error',e=>{console.error(e.code);process.exit(e.code==='EPERM'?77:1)}).on('connect',()=>process.exit(0));",
      ],
    ].map(([id, ...args]) => {
      const r = spawnSync("/usr/bin/sandbox-exec", ["-f", file, ...args], {
        cwd: work,
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      return {
        id,
        blocked: r.status !== 0,
        permissionDenied:
          id === "network"
            ? r.status === 77 && /EPERM/.test(r.stderr ?? "")
            : /Operation not permitted|Permission denied/.test(r.stderr ?? ""),
      };
    });
    const valid =
      version === "base"
        ? result.status === 1 && /AssertionError|expected .* to|ERR_ASSERTION/.test(log)
        : result.status === 0;
    const record = { case: item.id, version, status: result.status, valid, probes };
    records.push(record);
    console.log(JSON.stringify(record));
  }
writeFileSync(join(output, "results.json"), JSON.stringify(records, null, 2));
if (records.some((r) => !r.valid || r.probes.some((p) => !p.blocked || !p.permissionDenied)))
  process.exitCode = 1;
