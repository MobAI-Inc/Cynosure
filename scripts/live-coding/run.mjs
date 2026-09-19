// SPDX-License-Identifier: Apache-2.0
// Source-only historical fixes, independent copies, real Pi tools, and online feedback.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/store.ts";
import { toolPolicy as makeToolPolicy } from "./policy.mjs";

const source = resolve("."),
  root = resolve(process.argv[2]);
const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8"));
const piDir = realpathSync(
  "/Users/rydia/.nvm/current/lib/node_modules/@earendil-works/pi-coding-agent",
);
const node = realpathSync(process.execPath);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
function verifySourceOnly(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry),
      stat = lstatSync(path);
    if (stat.isDirectory()) verifySourceOnly(path);
    else if (!stat.isFile() || !/\.(?:[cm]?jsx?|tsx?|py|sql)$/.test(entry))
      throw new Error(`Refusing non-source snapshot entry: ${path}`);
  }
}
mkdirSync(join(root, "online"), { recursive: true });
const runtimeFile = join(root, "runtime.json");
if (!existsSync(runtimeFile)) {
  const initial = JSON.parse(readFileSync(join(source, "config/router.example.json"), "utf8"));
  initial.auditRate = 0;
  writeFileSync(runtimeFile, JSON.stringify(initial, null, 2));
}
const config = JSON.parse(readFileSync(runtimeFile, "utf8"));
function run(args, options, log, timeout = 1200000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(args[0], args.slice(1), {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }, timeout);
    for (const channel of [child.stdout, child.stderr])
      channel.on("data", (buf) => appendFileSync(log, buf));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal });
    });
  });
}
async function trial(item, model, round) {
  const id = `${round}-${item.id}-${model}`,
    dir = join(root, "runs", id);
  if (existsSync(join(dir, "result.json")))
    return JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  if (existsSync(dir))
    throw new Error(`Incomplete trial exists: ${id}; inspect before retrying paid work`);
  const work = join(dir, "code"),
    scratch = join(dir, "scratch"),
    agent = join(dir, "agent");
  const snapshot = join(root, "snapshots", item.id, "base");
  verifySourceOnly(snapshot);
  mkdirSync(dir, { recursive: true });
  cpSync(snapshot, work, { recursive: true });
  if (item.id.startsWith("cocos-"))
    cpSync(
      join(source, "scripts/live-coding/cocos-regressions.test.ts"),
      join(work, "__cynosure.test.ts"),
    );
  mkdirSync(scratch);
  mkdirSync(agent);
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      quietStartup: true,
    }),
  );
  mkdirSync(join(root, mode.startsWith("pilot") ? mode : "online"), { recursive: true });
  const dbpath =
    model === "auto"
      ? join(root, mode.startsWith("pilot") ? mode : "online", "experience.sqlite")
      : join(dir, "baseline.sqlite");
  const check = [node, join(source, "scripts/live-coding/check.mjs"), item.id, work, scratch]
    .map(quote)
    .join(" ");
  const protectedPaths = [join(work, ".git"), join(work, item.test ?? "__cynosure.test.ts")];
  const expectedTestHash = hash(readFileSync(protectedPaths[1]));
  const toolPolicy = join(dir, "tools.sb");
  const testScripts = join(source, "scripts/live-coding");
  writeFileSync(
    toolPolicy,
    makeToolPolicy(source, [work, scratch, testScripts], [work, scratch], protectedPaths),
  );
  const preflight = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-f", toolPolicy, node, join(source, "scripts/live-coding/check.mjs"), item.id, work, scratch],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 90000,
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
    },
  );
  writeFileSync(join(dir, "before.log"), (preflight.stdout ?? "") + (preflight.stderr ?? ""));
  if (
    preflight.status !== 1 ||
    !/AssertionError|AssertionError:|expected .* to|ERR_ASSERTION/.test(
      (preflight.stdout ?? "") + (preflight.stderr ?? ""),
    )
  )
    throw new Error(`Expected reproducible failing tests, got ${preflight.status}: ${id}`);
  const prompt = `${item.prompt}\n\nThis is a disposable source-only historical project snapshot. Implement the repair in the code. Do not install packages or contact deployed services. Existing runtimes are available. Do not modify tests or introduce fake passing checks. Relevant owner files: ${item.targets.join(", ")}.\nRun the external regression checks using:\n${check}\nThese checks are part of this explicitly authorized experiment. They execute only locally. Work only in this copy and finish with a brief summary.`;
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    TMPDIR: scratch,
    LANG: "en_US.UTF-8",
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    CYNOSURE_CONFIG: join(root, "runtime.json"),
    CYNOSURE_DB: dbpath,
    CYNOSURE_SCOPE: "moonshort-coding",
    CYNOSURE_SESSION_ID: id,
    CODING_TOOL_POLICY: toolPolicy,
    CODING_CHECK_SCRIPTS: testScripts,
    CODING_TEST_FILE: join(work, item.test ?? "__cynosure.test.ts"),
    CODING_SCRATCH: scratch,
    [config.router.apiKeyEnv]: process.env[config.router.apiKeyEnv],
  };
  const started = Date.now();
  writeFileSync(
    join(dir, "input.json"),
    JSON.stringify({ id, case: item.id, model, round, base: item.base, prompt }, null, 2),
  );
  const processResult = await run(
    [
      node,
      join(piDir, "dist/bundle/cli.js"),
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "-e",
      join(source, "integrations/pi/index.ts"),
      "-e",
      join(testScripts, "isolate.ts"),
      "--provider",
      "cynosure",
      "--model",
      model,
      "--mode",
      "json",
      "--no-session",
      "--tools",
      "read,bash,edit,write",
      "-p",
      prompt,
    ],
    { cwd: work, env },
    join(dir, "pi.jsonl"),
  );
  const after = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-f", toolPolicy, node, join(testScripts, "check.mjs"), item.id, work, scratch],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 90000,
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
    },
  );
  const testLog = (after.stdout ?? "") + (after.stderr ?? "");
  writeFileSync(join(dir, "after.log"), testLog);
  const testIntegrity =
    existsSync(protectedPaths[1]) && hash(readFileSync(protectedPaths[1])) === expectedTestHash;
  const checksPassed = after.status === 0 && testIntegrity;
  const db = new Store(dbpath);
  const tasks = db.db
    .prepare("SELECT id,body FROM tasks ORDER BY created")
    .all()
    .filter((r) => JSON.parse(r.body).sessionId === id);
  const toolCalls = tasks.reduce(
    (n, t) => n + db.events(t.id, "feedback").filter((f) => f.observation?.toolCallId).length,
    0,
  );
  for (const t of tasks)
    db.feedback(t.id, {
      source: "host-regression",
      verdict: checksPassed ? "met" : "unmet",
      scope: "task",
      note: "External targeted regression result for the whole trajectory. This is not overall user acceptance or isolated credit to each model.",
      toolCalls,
      observation: {
        sessionId: id,
        exitCode: after.status,
        checksPassed,
        testIntegrity,
        log: testLog.slice(-10000),
        attribution: "whole-trajectory",
        baselineFailed: preflight.status === 1,
      },
    });
  const calls = tasks.flatMap((t) =>
    db.db
      .prepare("SELECT body FROM calls WHERE task_id=?")
      .all(t.id)
      .map((r) => JSON.parse(r.body)),
  );
  const decisions = tasks.flatMap((t) =>
    db.events(t.id, "decision").map((d) => ({
      taskId: t.id,
      stage: d.stage,
      choice: d.answers.action?.choice,
      evidenceIds: d.evidenceIds,
    })),
  );
  const result = {
    id,
    case: item.id,
    model,
    round,
    checksPassed,
    testIntegrity,
    testExit: after.status,
    process: processResult,
    elapsedMs: Date.now() - started,
    turns: tasks.length,
    toolCalls,
    generations: calls.filter((c) => c.kind === "generation").length,
    decisionCalls: calls.filter((c) => c.kind === "decision").length,
    models: calls.filter((c) => c.kind === "generation").map((c) => c.model),
    reportedMicroUsd: calls
      .filter((c) => c.charge.basis === "reported")
      .reduce((n, c) => n + (c.charge.microUsd ?? 0), 0),
    estimatedMicroUsd: calls
      .filter((c) => c.charge.basis === "estimated")
      .reduce((n, c) => n + (c.charge.microUsd ?? 0), 0),
    unknownBills: calls.filter((c) => c.charge.basis === "unknown").length,
    decisions,
  };
  db.close();
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  appendFileSync(join(root, "results.jsonl"), `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify(result));
  return result;
}
const mode = process.argv[3] ?? "all";
if (mode.startsWith("pilot")) await trial(cases[0], "auto", mode);
else if (mode === "fixed") {
  for (const item of cases)
    for (let i = 0; i < config.routes.length; i += 2)
      await Promise.all(config.routes.slice(i, i + 2).map((r) => trial(item, r.id, "fixed")));
} else {
  for (const item of cases) {
    await trial(item, "auto", "cold");
    // Independent source copies, the same test command, no feedback shared with adaptive arm.
    for (let i = 0; mode !== "adaptive" && i < config.routes.length; i += 2)
      await Promise.all(config.routes.slice(i, i + 2).map((r) => trial(item, r.id, "fixed")));
  }
  for (const item of cases) await trial(item, "auto", "repeat");
}
const originals = [...new Set(cases.map((c) => c.repo))].map((repo) => {
  const expected = cases.find((c) => c.repo === repo);
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const diff = spawnSync("git", ["-C", repo, "diff", "HEAD", "--binary"]).stdout;
  return {
    repo,
    unchangedHead: head === expected.originalHead,
    unchangedTrackedWork: hash(diff) === expected.originalDiffSha256,
  };
});
writeFileSync(join(root, "originals-check.json"), JSON.stringify(originals, null, 2));
