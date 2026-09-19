// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import type { ChoiceAnswer, ChoiceQuestion, Config, Task } from "../src/types.ts";

export function first<T>(values: T[]): T {
  const value = values[0];
  assert.ok(value);
  return value;
}

export function config(): Config {
  const model = {
    revision: "test-v1",
    maxInputBytes: 100_000,
    reserveMicroUsd: 1000,
  };
  return {
    router: { baseUrl: "https://router.test/v1", apiKeyEnv: "TEST_ROUTER_KEY" },
    jev: {
      ...model,
      id: "typesafe/jev",
    },
    embedding: { ...model, id: "embed" },
    routes: [
      { ...model, id: "a" },
      { ...model, id: "b" },
    ],
    fallbackModel: "a",
    limits: {
      timeoutMs: 5000,
      maxDecisionCalls: 4,
      maxParallel: 2,
      maxResponseBytes: 100_000,
      maxEvidenceBytes: 40000,
    },
    memory: { topK: 4, maxAgeDays: 30 },
    auditRate: 0,
  };
}
export const env = { TEST_ROUTER_KEY: "synthetic-router-test" };
export function task(id = "task", scope = "test"): Task {
  return {
    id,
    scope,
    prompt: "Rewrite the scheduled water interruption notice without losing times.",
    goal: "Preserve facts and prefer lower total cost when requirements are met.",
    budgetMicroUsd: 20_000,
  };
}
interface Body {
  url: string;
  model: string;
  encoding_format?: string;
  messages: Array<{ role: string; content: string }>;
  questions: Record<string, ChoiceQuestion>;
  state: { outputs: unknown[]; experience: unknown[] };
}
export type Handler = (url: string, body: Body) => unknown | Promise<unknown>;
export function fakeFetch(handler?: Handler): { fetch: typeof fetch; bodies: Body[] } {
  const bodies: Body[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input),
      body: Body = JSON.parse(String(init?.body));
    bodies.push({ ...body, url });
    const custom = await handler?.(url, body);
    if (custom instanceof Response) return custom;
    if (custom !== undefined) return Response.json(custom);
    const usage = { input_tokens: 100, output_tokens: 20, cost: 0.0001 };
    if (url.endsWith("/embeddings"))
      return Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }], usage });
    if (url.endsWith("/decisions")) {
      const answers: Record<string, ChoiceAnswer> = {};
      for (const [key, question] of Object.entries(body.questions)) {
        const keys = Object.keys(question.criteria);
        const choice = key.startsWith("quality_")
          ? "met"
          : body.state.outputs.length
            ? (keys.find((k) => k.startsWith("deliver_")) ?? "fallback")
            : body.state.experience.length
              ? (keys.find((k) => k.startsWith("run_")) ?? "compare_all")
              : "compare_all";
        answers[key] = {
          type: "choice",
          choice,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
          confidence: 1,
        };
      }
      return Response.json({ model: body.model, answers, usage });
    }
    return Response.json({
      model: body.model,
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: `Answer from ${body.model}` },
        },
      ],
      usage,
    });
  };
  return { fetch: f as typeof fetch, bodies };
}
