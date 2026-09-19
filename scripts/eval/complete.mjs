// SPDX-License-Identifier: Apache-2.0
// Finish the already-started learning batch, then run the two frozen matrices.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2]);
const cache = process.argv[3] ? resolve(process.argv[3]) : null;
const state = (phase, detail = {}) =>
  writeFileSync(
    `${root}/pipeline.json`,
    JSON.stringify(
      {
        phase,
        at: new Date().toISOString(),
        ...detail,
      },
      null,
      2,
    ),
  );
const rows = (phase) =>
  existsSync(`${root}/${phase}.rows.jsonl`)
    ? readFileSync(`${root}/${phase}.rows.jsonl`, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
function coverage(phase, count) {
  const records = rows(phase);
  const ids = records.map((r) => r.response?.metadata?.trialId);
  if (records.length !== count || ids.some((id) => !id) || new Set(ids).size !== count)
    throw new Error(`Incomplete or duplicate ${phase} matrix`);
}
function run(args, expectedEvaluationFailure = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 || (expectedEvaluationFailure && code === 100)
        ? resolveRun()
        : reject(new Error(`Child exited ${code}`)),
    );
  });
}
try {
  state("waiting-for-learning");
  const deadline = Date.now() + 3_600_000;
  while (rows("learn").length < 40) {
    if (Date.now() > deadline) throw new Error("Learning batch did not finish within one hour");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30000));
  }
  coverage("learn", 40);
  state("freezing-experience");
  if (!existsSync(`${root}/seed.sqlite`))
    await run([
      "--env-file-if-exists=.env",
      "scripts/eval/seed.mjs",
      root,
      ...(cache ? [cache] : []),
    ]);
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
  manifest["seed.sqlite"] = createHash("sha256")
    .update(readFileSync(`${root}/seed.sqlite`))
    .digest("hex");
  writeFileSync(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));
  for (const phase of ["heldout-1", "heldout-2"]) {
    state(phase);
    if (rows(phase).length === 0) await run(["scripts/eval/run.mjs", root, phase], true);
    coverage(phase, 120);
    await run(["scripts/eval/analyze.mjs", root]);
  }
  const report = JSON.parse(readFileSync(`${root}/analysis.json`, "utf8"));
  if (!report.complete) throw new Error("Final coverage check failed");
  await new Promise((resolveRender, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      ["scripts/eval/render-report.py", root, `${root}/report.md`],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolveRender() : reject(new Error("Report render failed")),
    );
  });
  state("complete", {
    trials: 280,
    report: `${root}/report.md`,
  });
} catch (error) {
  state("failed", { error: error.message });
  process.exitCode = 1;
}
