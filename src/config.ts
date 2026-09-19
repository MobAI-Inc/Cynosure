// SPDX-License-Identifier: Apache-2.0
import type { Config, Model, Task } from "./types.ts";

export function integer(value: unknown, label: string, min = 0, max = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Invalid ${label}`);
  return value as number;
}
export function text(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}`);
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function url(value: unknown): string {
  const parsed = new URL(text(value, "URL", 2000));
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Invalid URL");
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
  )
    throw new Error("HTTPS required except on loopback");
  return parsed.toString().replace(/\/$/, "");
}
function envName(value: unknown): string {
  const name = text(value, "key environment name", 100);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("Invalid environment name");
  return name;
}
function model(value: unknown): Model {
  const m = object(value);
  if (m.maxOutputTokens !== undefined)
    throw new Error(
      "Remove maxOutputTokens: generation uses 262144 or the provider capability ceiling",
    );
  const result: Model = {
    id: text(m.id, "model id", 200),
    revision: text(m.revision, "model revision", 200),
    maxInputBytes: integer(m.maxInputBytes, "maxInputBytes", 100, 1_000_000),
    ...(m.outputTokenLimit === undefined
      ? {}
      : {
          outputTokenLimit: integer(m.outputTokenLimit, "outputTokenLimit", 1, 1_000_000),
        }),
    reserveMicroUsd: integer(m.reserveMicroUsd, "reserveMicroUsd", 1),
  };
  if (m.pricing !== undefined) {
    const p = object(m.pricing);
    result.pricing = {
      input: integer(p.input, "input price", 0, 1e12),
      output: integer(p.output, "output price", 0, 1e12),
      source: text(p.source, "price source"),
    };
  }
  return result;
}
export function parseConfig(value: unknown): Config {
  const c = object(value),
    r = object(c.router),
    j = object(c.jev),
    l = object(c.limits),
    m = object(c.memory);
  if (!Array.isArray(c.routes) || c.routes.length < 1 || c.routes.length > 16)
    throw new Error("Use 1–16 routes");
  const routes = c.routes.map(model);
  if (new Set(routes.map((x) => x.id)).size !== routes.length)
    throw new Error("Duplicate route id");
  const fallbackModel = text(c.fallbackModel, "fallbackModel", 200);
  if (!routes.some((m) => m.id === fallbackModel))
    throw new Error("Fallback must be a configured route");
  if (
    typeof c.auditRate !== "number" ||
    !Number.isFinite(c.auditRate) ||
    c.auditRate < 0 ||
    c.auditRate > 1
  )
    throw new Error("Invalid auditRate");
  return {
    router: { baseUrl: url(r.baseUrl), apiKeyEnv: envName(r.apiKeyEnv) },
    jev: model(j),
    embedding: model(c.embedding),
    routes,
    fallbackModel,
    ...(c.judge === undefined ? {} : { judge: model(c.judge) }),
    limits: {
      timeoutMs: integer(l.timeoutMs, "timeoutMs", 100, 3_600_000),
      maxDecisionCalls: integer(l.maxDecisionCalls, "maxDecisionCalls", 2, 20),
      maxParallel: integer(l.maxParallel, "maxParallel", 1, 16),
      maxResponseBytes: integer(l.maxResponseBytes, "maxResponseBytes", 1000, 100_000_000),
      maxEvidenceBytes: integer(l.maxEvidenceBytes, "maxEvidenceBytes", 100, 500_000),
    },
    memory: {
      topK: integer(m.topK, "topK", 1, 20),
      maxAgeDays: integer(m.maxAgeDays, "maxAgeDays", 1, 3650),
    },
    auditRate: c.auditRate,
  };
}
export function parseTask(value: unknown): Task {
  const t = object(value);
  if (t.mode !== undefined && !["adaptive", "compare"].includes(String(t.mode)))
    throw new Error("Invalid mode");
  return {
    id: text(t.id, "task id", 200),
    scope: text(t.scope, "scope", 200),
    prompt: text(t.prompt, "prompt"),
    goal: text(t.goal, "goal", 10_000),
    budgetMicroUsd: integer(t.budgetMicroUsd, "budgetMicroUsd", 1),
    ...(t.mode === undefined ? {} : { mode: t.mode as Task["mode"] & string }),
    ...(t.context === undefined ? {} : { context: t.context as Task["context"] & {} }),
    ...(t.sessionId === undefined ? {} : { sessionId: text(t.sessionId, "session id", 200) }),
  };
}
