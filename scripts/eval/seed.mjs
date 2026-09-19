// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Providers } from "../../src/providers.ts";
import { embeddingSpace, Store } from "../../src/store.ts";

const root = resolve(process.argv[2]),
  config = JSON.parse(readFileSync(`${root}/runtime.json`, "utf8")),
  plan = JSON.parse(readFileSync(`${root}/plan.json`, "utf8"));
const cases = JSON.parse(readFileSync(`${root}/cases.json`, "utf8")).filter(
  (c) => c.split === "learn",
);
const rows = readFileSync(`${root}/learn.rows.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
if (rows.length !== cases.length * config.routes.length)
  throw new Error("Incomplete learning matrix");
if (existsSync(`${root}/seed.sqlite`)) throw new Error("Frozen learning snapshot already exists");
const store = new Store(`${root}/seed.sqlite`),
  summary = [];
try {
  for (const item of cases) {
    const task = {
      id: `learning-${item.id}`,
      scope: "benchmark-learning",
      prompt: item.question,
      goal: plan.goal,
      budgetMicroUsd: plan.taskBudgetMicroUsd,
    };
    store.create(task, config, config.routes);
    const group = rows.filter((r) => r.response?.metadata?.caseId === item.id);
    if (group.length !== 4) throw new Error("Learning coverage gap");
    const runs = [];
    for (const row of group) {
      const m = row.response.metadata;
      const originalRuns = (m.attempts ?? []).flatMap((a) => a.runs);
      for (const observed of m.calls ?? []) {
        if (observed.kind !== "generation") continue;
        const model = config.routes.find((x) => x.id === observed.model);
        const call = store.reserve(task.id, "generation", model);
        store.settle(call, observed.charge, observed.elapsedMs, observed.error);
        const old = originalRuns.find((r) => r.callId === observed.id);
        const run = old
          ? { ...old, id: randomUUID(), callId: call.id }
          : {
              id: randomUUID(),
              callId: call.id,
              route: model.id,
              revision: model.revision,
              status: "failed",
              output: null,
              error: observed.error ?? "No executable output",
              elapsedMs: observed.elapsedMs,
              charge: observed.charge,
              toolCalls: null,
              observationScope: "request",
            };
        store.event(task.id, "run", run);
        runs.push(run);
        store.feedback(task.id, {
          source: "Aider Polyglot official pytest execution",
          verdict: !run.observation ? "unknown" : run.observation.allTestsPassed ? "met" : "unmet",
          note: JSON.stringify({
            case: item.id,
            tests: run.observation?.tests,
            failures: run.observation?.failures,
            errors: run.observation?.errors,
            exitCode: run.observation?.exitCode,
            transportError: observed.error,
          }),
          runId: run.id,
          ...(run.observation ? { toolCalls: 1 } : {}),
          scope: "request",
        });
      }
    }
    const query = `${task.prompt}\nGoal: ${task.goal}`;
    const previous = process.argv[3] ? new Store(resolve(process.argv[3])) : null;
    let values;
    try {
      values = previous?.cachedEmbedding(task.scope, embeddingSpace(config.embedding), query);
    } finally {
      previous?.close();
    }
    values ??= (await new Providers(config, store).embed(task.id, query)).value;
    store.saveEmbedding(task.id, embeddingSpace(config.embedding), query, values);
    // A learning record is a comparison, not a model-quality ranking.
    store.finish({
      taskId: task.id,
      status: "stopped",
      output: null,
      selectedRunId: null,
      selectedModel: null,
      evidenceIds: [],
      runIds: runs.map((r) => r.id),
      totals: store.totals(task.id),
      error: "Frozen observed comparison; no ranked winner assigned",
    });
    summary.push({
      id: task.id,
      runs: runs.length,
      feedback: store.experience(task.id).feedback.length,
      bytes: Buffer.byteLength(JSON.stringify(store.experience(task.id))),
    });
    console.log(JSON.stringify(summary.at(-1)));
  }
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} finally {
  store.close();
}
writeFileSync(`${root}/seed-summary.json`, JSON.stringify(summary, null, 2));
