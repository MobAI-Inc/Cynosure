// SPDX-License-Identifier: Apache-2.0
// Thin promptfoo adapter for the Aider test-and-repair protocol, not a scorer.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 20);
function execute(source, output, artifact) {
  return new Promise((resolveResult, reject) => {
    const p = spawn("/usr/bin/python3", [resolve("scripts/eval/execute.py")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      _stderr = "";
    p.stdout.on("data", (x) => {
      stdout += x;
    });
    p.stderr.on("data", (x) => {
      _stderr += x;
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error("Test executor failed"));
      else {
        try {
          resolveResult(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid test report"));
        }
      }
    });
    p.stdin.end(JSON.stringify({ source, output, artifact }));
  });
}
export default class RouterProvider {
  constructor(options) {
    this.options = options.config;
    this.root = resolve(this.options.root);
    this.config = JSON.parse(readFileSync(join(this.root, "runtime.json"), "utf8"));
    this.plan = JSON.parse(readFileSync(join(this.root, "plan.json"), "utf8"));
    this.cases = JSON.parse(readFileSync(join(this.root, "cases.json"), "utf8"));
    this.providerId = this.options.mode === "cynosure" ? "cynosure" : this.options.model;
    if (
      [this.config.jev.id, this.config.embedding.id, ...this.config.routes.map((m) => m.id)].some(
        (id) => !this.plan.allowedModels.includes(id),
      )
    )
      throw new Error("Model outside frozen allowlist");
    if (this.options.model && !this.config.routes.some((m) => m.id === this.options.model))
      throw new Error("Model outside configured candidates");
  }
  id() {
    return this.providerId;
  }
  async callApi(prompt, context) {
    // A running frozen comparison must not pick up later product changes.
    const source = existsSync(join(this.root, "protocol-snapshot/src/router.ts"))
      ? join(this.root, "protocol-snapshot/src")
      : resolve("src");
    const [{ Providers }, { Cynosure }, { Store }] = await Promise.all([
      import(pathToFileURL(join(source, "providers.ts")).href),
      import(pathToFileURL(join(source, "router.ts")).href),
      import(pathToFileURL(join(source, "store.ts")).href),
    ]);
    const caseId = String(context.vars.caseId),
      item = this.cases.find((c) => c.id === caseId);
    if (!item || prompt !== item.question)
      throw new Error("Prompt differs from frozen official case");
    const trialId = `${this.options.phase}-${hash(caseId)}-${hash(this.providerId)}`;
    const directory = join(this.root, "runs", trialId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const sqlitePath = join(directory, "experience.sqlite");
    if (existsSync(sqlitePath)) return { error: "Existing trial: refuse duplicate paid inference" };
    if (this.options.mode === "cynosure") copyFileSync(join(this.root, "seed.sqlite"), sqlitePath);
    const store = new Store(sqlitePath),
      attempts = [];
    let currentPrompt = prompt,
      totalStart = performance.now();
    try {
      for (let attempt = 0; attempt < this.plan.maxAttempts; attempt++) {
        const taskId = `${trialId}-${attempt}`,
          task = {
            id: taskId,
            scope: this.options.mode === "cynosure" ? "benchmark-learning" : trialId,
            prompt: currentPrompt,
            goal: this.plan.goal,
            budgetMicroUsd: this.plan.taskBudgetMicroUsd,
          };
        let result, selectedRun;
        if (this.options.mode === "cynosure") {
          result = await new Cynosure(this.config, store, {
            observeRun: async (_task, run) => {
              const observation = await execute(item.source, run.output, join(directory, run.id));
              return observation;
            },
          }).run(task);
          selectedRun = store.events(taskId, "run").find((r) => r.id === result.selectedRunId);
          if (!selectedRun)
            selectedRun = store
              .events(taskId, "run")
              .filter((r) => r.output)
              .at(-1);
        } else {
          const model = this.config.routes.find((m) => m.id === this.options.model);
          store.create(task, this.config, [model]);
          try {
            const reply = await new Providers(this.config, store).generate(taskId, model, [
              { role: "system", content: `Task goal: ${task.goal}` },
              { role: "user", content: currentPrompt },
            ]);
            selectedRun = {
              id: randomUUID(),
              route: model.id,
              revision: model.revision,
              callId: reply.call.id,
              status: "complete",
              output: reply.value,
              error: null,
              elapsedMs: reply.call.elapsedMs,
              charge: reply.call.charge,
              toolCalls: null,
              observationScope: "request",
            };
            selectedRun.observation = await execute(
              item.source,
              reply.value,
              join(directory, selectedRun.id),
            );
            store.event(taskId, "run", selectedRun);
            result = {
              taskId,
              status: "delivered",
              output: reply.value,
              selectedRunId: selectedRun.id,
              selectedModel: model.id,
              evidenceIds: [],
              runIds: [selectedRun.id],
              totals: store.totals(taskId),
              error: null,
            };
          } catch (error) {
            result = {
              taskId,
              status: "failed",
              output: null,
              selectedRunId: null,
              selectedModel: null,
              evidenceIds: [],
              runIds: [],
              totals: store.totals(taskId),
              error: error.call ? error.message : "Execution failed",
            };
          }
          store.finish(result);
        }
        const runs = store.events(taskId, "run");
        const observation = selectedRun?.observation;
        const passed = result.status === "delivered" && observation?.allTestsPassed === true;
        attempts.push({ taskId, result, runs, allTestsPassed: passed, observation });
        if (passed || !selectedRun?.output || attempt + 1 === this.plan.maxAttempts) break;
        // Aider's official benchmark allows one repair using test failures.
        currentPrompt =
          prompt +
          "\n\nPrevious submitted code:\n" +
          selectedRun.output +
          "\n\n" +
          (observation?.log ?? "Test result unavailable.") +
          "\n####\nSee the testing errors above.\nThe tests are correct, do not try and change them.\nFix the code in " +
          item.solutionFile +
          " to resolve the errors.";
      }
      const calls = attempts.flatMap((a) =>
        store.db
          .prepare("SELECT body FROM calls WHERE task_id=?")
          .all(a.taskId)
          .map((r) => JSON.parse(r.body)),
      );
      const totals = {
        reportedMicroUsd: 0,
        estimatedMicroUsd: 0,
        unknownCalls: 0,
        calls: calls.length,
      };
      for (const c of calls) {
        if (c.charge.basis === "reported") totals.reportedMicroUsd += c.charge.microUsd ?? 0;
        else if (c.charge.basis === "estimated") totals.estimatedMicroUsd += c.charge.microUsd ?? 0;
        else totals.unknownCalls++;
      }
      const last = attempts.at(-1),
        output = last?.result.output ?? last?.runs.filter((r) => r.output).at(-1)?.output;
      return {
        ...(output ? { output } : { error: last?.result.error ?? "No output" }),
        cost: totals.reportedMicroUsd / 1e6,
        cached: false,
        metadata: {
          trialId,
          caseId,
          sqlitePath,
          provider: this.providerId,
          firstPass: attempts[0]?.allTestsPassed ?? false,
          finalPass: last?.allTestsPassed ?? false,
          attempts,
          totals,
          elapsedMs: Math.round(performance.now() - totalStart),
          calls,
        },
      };
    } catch (error) {
      return {
        error: "Benchmark adapter failed",
        metadata: { trialId, caseId, sqlitePath, errorType: error.constructor.name },
      };
    } finally {
      store.close();
    }
  }
}
