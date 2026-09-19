// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Cynosure } from "../src/router.ts";
import { Store } from "../src/store.ts";
import type { Decision, Evaluation, Run } from "../src/types.ts";
import { config, env, fakeFetch, first, task } from "./fixtures.ts";

test("cold comparison persists; a new request retrieves experience and runs fewer routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cynosure-")),
    path = join(dir, "memory.sqlite");
  let db = new Store(path);
  try {
    const mock = fakeFetch();
    const cold = await new Cynosure(config(), db, { fetch: mock.fetch, env }).run({
      ...task("cold"),
      mode: "compare",
    });
    assert.equal(cold.status, "delivered");
    assert.equal(cold.runIds.length, 2);
    assert.equal(cold.totals.calls, 5);
    assert.equal(cold.totals.reportedMicroUsd, 500);
    assert.equal(db.events<Evaluation>("cold", "evaluation").length, 2);
    db.feedback("cold", {
      source: "independent-user",
      verdict: "met",
      note: "All facts retained",
      scope: "task",
      toolCalls: 2,
    });
    db.close();
    db = new Store(path);
    const warm = await new Cynosure(config(), db, { fetch: mock.fetch, env }).run({
      ...task("warm"),
      prompt: "Please rephrase the planned water outage announcement, preserving its schedule.",
    });
    assert.equal(warm.status, "delivered");
    assert.equal(warm.runIds.length, 1);
    assert.deepEqual(warm.evidenceIds, ["cold"]);
    const d = first(db.events<Decision>("warm", "decision"));
    assert.match(JSON.stringify(d.state), /independent-user/);
    assert.match(JSON.stringify(d.state), /All facts retained/);
    assert.equal(warm.totals.calls, 4);
    const before = mock.bodies.length;
    await assert.rejects(
      () => new Cynosure(config(), db, { fetch: mock.fetch, env }).run(task("warm")),
      /UNIQUE/,
    );
    assert.equal(mock.bodies.length, before);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retrieval isolates scopes and requires feedback run IDs to belong to the task", async () => {
  const db = new Store(":memory:"),
    mock = fakeFetch();
  try {
    const router = new Cynosure(config(), db, { fetch: mock.fetch, env });
    await router.run(task("private", "customer-a"));
    const other = await router.run(task("other", "customer-b"));
    assert.deepEqual(other.evidenceIds, []);
    assert.equal(other.runIds.length, 2);
    assert.throws(
      () =>
        db.feedback("other", {
          source: "host",
          verdict: "met",
          note: "ok",
          scope: "task",
          runId: first(db.events<Run>("private", "run")).id,
        }),
      /Unknown feedback run/,
    );
  } finally {
    db.close();
  }
});

test("evaluation does not veto a selected complete answer", async () => {
  const db = new Store(":memory:");
  const mock = fakeFetch((_url, b) => {
    if (b.questions?.quality_0) {
      return {
        answers: Object.fromEntries(
          Object.entries(b.questions).map(([key, q]) => {
            const choice = key === "action" ? "deliver_0" : "unmet";
            return [
              key,
              {
                type: "choice",
                choice,
                probabilities: Object.fromEntries(
                  Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
                ),
              },
            ];
          }),
        ),
        usage: { cost: 0.0001 },
      };
    }
  });
  try {
    const result = await new Cynosure(config(), db, { fetch: mock.fetch, env }).run(task());
    assert.equal(result.status, "delivered");
    assert.ok(result.output);
    assert.equal(result.delivery?.via, "jev");
    assert.ok(db.events<Evaluation>("task", "evaluation").some((e) => e.verdict === "unmet"));
  } finally {
    db.close();
  }
});

test("unfinished and empty completions cannot become successful runs", async () => {
  const db = new Store(":memory:"),
    mock = fakeFetch((url, b) => {
      if (url.endsWith("/chat/completions"))
        return {
          choices: [
            {
              finish_reason: b.model === "a" ? "length" : "stop",
              message: { content: b.model === "a" ? "partial" : "" },
            },
          ],
          usage: { cost: 0.0001 },
        };
    });
  try {
    const result = await new Cynosure(config(), db, { fetch: mock.fetch, env }).run(task());
    assert.equal(result.status, "failed");
    assert.equal(result.output, null);
    assert.ok(db.events<Run>("task", "run").every((r) => r.status === "failed"));
    assert.equal(db.events<Evaluation>("task", "evaluation").length, 0);
  } finally {
    db.close();
  }
});

test("unknown bills retain reservations; all-call budget includes embedding and decisions", async () => {
  const db = new Store(":memory:"),
    mock = fakeFetch((url) => {
      if (url.endsWith("/chat/completions"))
        return { choices: [{ finish_reason: "stop", message: { content: "unbilled answer" } }] };
    });
  try {
    const result = await new Cynosure(config(), db, { fetch: mock.fetch, env }).run({
      ...task(),
      budgetMicroUsd: 6000,
    });
    assert.equal(result.status, "delivered");
    assert.equal(result.totals.unknownCalls, 2);
    assert.equal(result.totals.committedMicroUsd, 2300);
    assert.equal(result.totals.reportedMicroUsd, 300);
    await assert.rejects(
      () =>
        new Cynosure(config(), db, { fetch: mock.fetch, env }).run({
          ...task("tiny"),
          budgetMicroUsd: 100,
        }),
      /Budget cannot cover/,
    );
  } finally {
    db.close();
  }
});

test("atomic reservations cannot oversubscribe one task", () => {
  const db = new Store(":memory:"),
    c = config(),
    t = { ...task(), budgetMicroUsd: 1500 };
  try {
    db.create(t, c, c.routes);
    db.reserve(t.id, "generation", first(c.routes));
    assert.throws(
      () => db.reserve(t.id, "generation", first(c.routes.slice(1))),
      /Budget exhausted/,
    );
    assert.equal(db.totals(t.id).calls, 1);
  } finally {
    db.close();
  }
});

test("invalid Jev output triggers recorded fallback delivery", async () => {
  const db = new Store(":memory:"),
    mock = fakeFetch((url) =>
      url.endsWith("/decisions")
        ? {
            answers: {
              action: {
                type: "choice",
                choice: "made-up-model",
                probabilities: { "made-up-model": 1 },
              },
            },
            usage: { cost: 0.0001 },
          }
        : undefined,
    );
  try {
    const result = await new Cynosure(config(), db, { fetch: mock.fetch, env }).run(task());
    assert.equal(result.status, "delivered");
    assert.equal(result.selectedModel, "a");
    assert.match(result.delivery?.reason ?? "", /Invalid Jev/);
    assert.equal(result.delivery?.via, "fallback");
    assert.equal(result.runIds.length, 1);
    assert.equal(result.totals.reportedMicroUsd, 300);
  } finally {
    db.close();
  }
});

test("embedding cache is scoped and versioned; changed embedding versions do not mix vectors", async () => {
  const db = new Store(":memory:"),
    mock = fakeFetch(),
    c = config();
  try {
    const router = new Cynosure(c, db, { fetch: mock.fetch, env });
    await router.run(task("one"));
    await router.run(task("two"));
    assert.equal(mock.bodies.filter((b) => b.url.endsWith("/embeddings")).length, 1);
    c.embedding.revision = "new-space";
    await new Cynosure(c, db, { fetch: mock.fetch, env }).run({
      ...task("three"),
      prompt: "火星矿业勘探预算",
      goal: "检查矿脉可用性",
    });
    assert.equal(mock.bodies.filter((b) => b.url.endsWith("/embeddings")).length, 2);
    assert.deepEqual(first(db.events<{ caseIds: string[] }>("three", "retrieval")).caseIds, []);
  } finally {
    db.close();
  }
});

test("embedding outage degrades visibly to full-text retrieval", async () => {
  const db = new Store(":memory:"),
    mock = fakeFetch();
  try {
    await new Cynosure(config(), db, { fetch: mock.fetch, env }).run(task("one"));
    const broken = fakeFetch((url) =>
      url.endsWith("/embeddings") ? new Response("unavailable", { status: 503 }) : undefined,
    );
    const result = await new Cynosure(config(), db, { fetch: broken.fetch, env }).run({
      ...task("two"),
      prompt: "Rewrite the scheduled water interruption notice with identical times and facts.",
    });
    assert.equal(result.status, "delivered");
    assert.deepEqual(result.evidenceIds, ["one"]);
    assert.equal(db.events("two", "retrieval-warning").length, 1);
    assert.equal(result.totals.unknownCalls, 1);
  } finally {
    db.close();
  }
});

test("independent judge retains unknown quality without blocking delivery", async () => {
  const db = new Store(":memory:"),
    c = config();
  c.judge = { ...first(c.routes), id: "reviewer" };
  const mock = fakeFetch((_url, b) => {
    if (b.model === "reviewer") {
      const review = JSON.parse(first(b.messages.slice(1)).content) as {
        outputs: Array<{ label: string; route?: string }>;
      };
      assert.ok(review.outputs.every((o) => !o.route));
      return {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                evaluations: review.outputs.map((o) => ({
                  label: o.label,
                  verdict: "unknown",
                  evidence: "Independent verification unavailable",
                })),
              }),
            },
          },
        ],
        usage: { cost: 0.0001 },
      };
    }
  });
  try {
    const result = await new Cynosure(c, db, { fetch: mock.fetch, env }).run(task());
    assert.equal(result.status, "delivered");
    assert.ok(result.output);
    assert.ok(db.events<Evaluation>("task", "evaluation").every((e) => e.verdict === "unknown"));
  } finally {
    db.close();
  }
});

test("cost overrun stops new work and remains visible", async () => {
  const db = new Store(":memory:"),
    mock = fakeFetch((url) =>
      url.endsWith("/embeddings")
        ? { data: [{ index: 0, embedding: [1, 0, 0] }], usage: { cost: 0.002 } }
        : undefined,
    );
  try {
    const result = await new Cynosure(config(), db, { fetch: mock.fetch, env }).run(task());
    assert.equal(result.status, "failed");
    assert.equal(result.totals.reportedMicroUsd, 2000);
    assert.equal(mock.bodies.length, 1);
  } finally {
    db.close();
  }
});

test("a generation overrun prevents queued candidates from starting", async () => {
  const db = new Store(":memory:"),
    c = config();
  c.limits.maxParallel = 1;
  c.routes.push({ ...first(c.routes), id: "c" });
  const mock = fakeFetch((url) =>
    url.endsWith("/chat/completions")
      ? {
          choices: [{ finish_reason: "stop", message: { content: "expensive" } }],
          usage: { cost: 0.002 },
        }
      : undefined,
  );
  try {
    const result = await new Cynosure(c, db, { fetch: mock.fetch, env }).run({
      ...task(),
      mode: "compare",
    });
    assert.equal(result.status, "failed");
    assert.equal(mock.bodies.filter((b) => b.url.endsWith("/chat/completions")).length, 1);
    assert.equal(result.runIds.length, 1);
  } finally {
    db.close();
  }
});

test("host test observations enter Jev state and persisted runs", async () => {
  const c = config(),
    db = new Store(":memory:");
  const mock = fakeFetch();
  try {
    const router = new Cynosure(c, db, {
      fetch: mock.fetch,
      env,
      observeRun: async () => ({ source: "official-pytest", exitCode: 0, tests: 9 }),
    });
    const result = await router.run(task("observed"));
    assert.equal(result.status, "delivered");
    const runs = db.experience("observed").runs;
    assert.ok(runs.every((r) => r.observation && typeof r.observation === "object"));
    const decision = db
      .events<{ state: { outputs: Array<{ observation: unknown }> } }>("observed", "decision")
      .at(-1);
    assert.deepEqual(decision?.state.outputs[0]?.observation, {
      source: "official-pytest",
      exitCode: 0,
      tests: 9,
    });
  } finally {
    db.close();
  }
});

test("Jev may explicitly delegate to fallback and host failure facts do not block delivery", async () => {
  const db = new Store(":memory:");
  const mock = fakeFetch((url, b) => {
    if (url.endsWith("/decisions"))
      return {
        answers: Object.fromEntries(
          Object.entries(b.questions).map(([key, q]) => [
            key,
            {
              type: "choice",
              choice: "fallback",
              probabilities: Object.fromEntries(
                Object.keys(q.criteria).map((k) => [k, k === "fallback" ? 1 : 0]),
              ),
            },
          ]),
        ),
        usage: { cost: 0.0001 },
      };
  });
  try {
    const result = await new Cynosure(config(), db, {
      fetch: mock.fetch,
      env,
      observeRun: async () => ({ allTestsPassed: false, failures: 1 }),
    }).run(task());
    assert.equal(result.status, "delivered");
    assert.equal(result.delivery?.via, "fallback");
    assert.equal(result.selectedModel, "a");
    assert.equal(
      db.events<Run>("task", "run")[0]?.observation &&
        JSON.stringify(db.events<Run>("task", "run")[0]?.observation),
      '{"allTestsPassed":false,"failures":1}',
    );
    assert.equal(db.events("task", "evaluation").length, 0);
  } finally {
    db.close();
  }
});

test("post-generation decision failure and fallback outage preserve the existing answer", async () => {
  const db = new Store(":memory:"),
    c = config();
  c.limits.maxDecisionCalls = 2;
  let decisionCount = 0,
    fallbackCalls = 0;
  const mock = fakeFetch((url, b) => {
    if (url.endsWith("/decisions")) {
      decisionCount++;
      if (decisionCount > 1) return new Response("down", { status: 503 });
      return {
        answers: {
          action: {
            type: "choice",
            choice: "run_1",
            probabilities: Object.fromEntries(
              Object.keys(b.questions.action?.criteria ?? {}).map((k) => [
                k,
                k === "run_1" ? 1 : 0,
              ]),
            ),
          },
        },
        usage: { cost: 0.0001 },
      };
    }
    if (url.endsWith("/chat/completions") && b.model === "a") {
      fallbackCalls++;
      return new Response("down", { status: 503 });
    }
  });
  try {
    const result = await new Cynosure(c, db, { fetch: mock.fetch, env }).run(task());
    assert.equal(result.status, "delivered");
    assert.equal(result.selectedModel, "b");
    assert.equal(result.delivery?.via, "fallback");
    assert.equal(fallbackCalls, 1);
    assert.equal(result.runIds.length, 2);
  } finally {
    db.close();
  }
});

test("a task with only fallback budget skips routing and completes directly", async () => {
  const db = new Store(":memory:"),
    mock = fakeFetch();
  try {
    const result = await new Cynosure(config(), db, { fetch: mock.fetch, env }).run({
      ...task(),
      budgetMicroUsd: 1000,
    });
    assert.equal(result.status, "delivered");
    assert.equal(result.delivery?.via, "fallback");
    assert.equal(mock.bodies.length, 1);
    assert.ok(mock.bodies[0]?.url.endsWith("/chat/completions"));
  } finally {
    db.close();
  }
});
