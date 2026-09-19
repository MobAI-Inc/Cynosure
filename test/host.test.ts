// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cynosure } from "../src/router.ts";
import { Store } from "../src/store.ts";
import type { Decision, HostGenerate, Run } from "../src/types.ts";
import { config, env, fakeFetch, task } from "./fixtures.ts";

test("host tool proposals use the normal router; executed feedback enters the next decision", async () => {
  const db = new Store(":memory:");
  try {
    const transport = fakeFetch();
    let generations = 0;
    const generate: HostGenerate = async (_task, route) => {
      generations++;
      return {
        output: JSON.stringify([
          { type: "toolCall", id: route.id, name: "bash", arguments: { command: "run checks" } },
        ]),
        charge: { microUsd: 10, basis: "reported", inputTokens: 5, outputTokens: 5 },
        observation: { proposedToolCalls: 1, executedToolCalls: 0, taskOutcome: "unknown" },
      };
    };
    const router = new Cynosure(config(), db, { fetch: transport.fetch, env, generate });
    const first = await router.run({
      ...task("first"),
      sessionId: "session",
      context: { turn: 1 },
    });
    assert.equal(first.status, "delivered");
    assert.equal(generations, 2);
    assert.equal(transport.bodies.filter((b) => b.url.endsWith("/chat/completions")).length, 0);
    assert.equal(db.events<Run>("first", "run")[0]?.toolCalls, null);
    db.feedback("first", {
      source: "pi",
      verdict: "unknown",
      note: "Actual check failed",
      scope: "request",
      runId: first.selectedRunId ?? "",
      toolCalls: 1,
      observation: { isError: true, exitCode: 1, log: "assertion failed" },
    });
    const second = await router.run({
      ...task("second"),
      sessionId: "session",
      context: { turn: 2, toolResult: "assertion failed" },
    });
    assert.equal(second.status, "delivered");
    const decision = db.events<Decision>("second", "decision")[0];
    assert.match(JSON.stringify(decision?.state), /Actual check failed/);
    assert.match(JSON.stringify(decision?.state), /receivedAt/);
    assert.match(JSON.stringify(decision?.state), /"turn":2/);
  } finally {
    db.close();
  }
});

test("host generation failures settle their reservation and still attempt configured fallback", async () => {
  const db = new Store(":memory:");
  try {
    const transport = fakeFetch();
    const tried: string[] = [];
    const cfg = config();
    cfg.limits.maxParallel = 1;
    const result = await new Cynosure(cfg, db, {
      fetch: transport.fetch,
      env,
      generate: async (_task, route) => {
        tried.push(route.id);
        if (tried.length <= 2) throw new Error("secret upstream payload");
        return {
          output: "complete fallback",
          charge: { microUsd: 10, basis: "reported", inputTokens: 5, outputTokens: 5 },
        };
      },
    }).run(task());
    assert.equal(result.status, "delivered");
    assert.equal(result.selectedModel, cfg.fallbackModel);
    assert.ok(tried.length >= 3);
    assert.doesNotMatch(JSON.stringify(db.events("task", "run")), /secret/);
    assert.equal(
      db.db
        .prepare("SELECT count(*) AS n FROM calls WHERE json_extract(body,'$.state')='reserved'")
        .get()?.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("a fallback outage still permits a different configured host model to deliver", async () => {
  const db = new Store(":memory:");
  try {
    const mock = fakeFetch((url, b) =>
      url.endsWith("/decisions")
        ? {
            answers: {
              action: {
                type: "choice",
                choice: "fallback",
                probabilities: Object.fromEntries(
                  Object.keys(b.questions.action?.criteria ?? {}).map((k) => [
                    k,
                    k === "fallback" ? 1 : 0,
                  ]),
                ),
              },
            },
            usage: { cost: 0.0001 },
          }
        : undefined,
    );
    const result = await new Cynosure(config(), db, {
      fetch: mock.fetch,
      env,
      generate: async (_task, route) => {
        if (route.id === "a") throw new Error("503");
        return {
          output: "useful tool proposal",
          charge: { microUsd: 10, basis: "reported", inputTokens: 5, outputTokens: 5 },
        };
      },
    }).run(task());
    assert.equal(result.status, "delivered");
    assert.equal(result.selectedModel, "b");
    assert.equal(result.runIds.length, 2);
  } finally {
    db.close();
  }
});
