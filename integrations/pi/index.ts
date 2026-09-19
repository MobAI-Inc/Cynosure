// SPDX-License-Identifier: Apache-2.0
// Loaded explicitly with pi -e; uses Pi's installed SDK, no extra dependencies.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAssistantMessageEventStream, streamSimple } from "@earendil-works/pi-ai/compat";
import { Cynosure, parseConfig, Store } from "../../dist/index.js";
import { chargeOf } from "../../dist/providers.js";

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const excerpt = (value, limit = 24000) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { text: text.slice(-limit), omittedCharacters: Math.max(0, text.length - limit) };
};
const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

export default function (pi) {
  const config = parseConfig(
    JSON.parse(
      readFileSync(
        process.env.CYNOSURE_CONFIG ?? new URL("../../config/router.example.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  // Jev chooses exploration on each real request. No calibrated audit rate or seed is required.
  config.auditRate = 0;
  const scope = process.env.CYNOSURE_SCOPE ?? resolve(process.cwd());
  const database = resolve(process.env.CYNOSURE_DB ?? ".cynosure/experience.sqlite");
  const sessionId = process.env.CYNOSURE_SESSION_ID ?? randomUUID();
  const budget = Number(process.env.CYNOSURE_REQUEST_BUDGET_MICRO_USD ?? 10000000);
  let store = null,
    active = null,
    userPrompt = "",
    turns = 0;
  const open = () => (store ??= new Store(database));
  const feedback = (input) => {
    if (!active) return;
    try {
      open().feedback(active.taskId, {
        source: "pi",
        verdict: "unknown",
        scope: "request",
        ...(active.selectedRunId ? { runId: active.selectedRunId } : {}),
        ...input,
      });
    } catch {
      /* Observability must not prevent the host from completing a task. */
    }
  };

  pi.on("input", (event) => {
    userPrompt = event.text;
    // A follow-up may correct an earlier answer; preserve it without inferring acceptance.
    feedback({
      note: "Subsequent user input; interpret in context, not automatically as rejection.",
      observation: { sessionId, userInput: event.text },
    });
  });
  pi.on("tool_result", (event) => {
    feedback({
      note: "Actual tool execution. Tool success alone does not establish task success.",
      toolCalls: 1,
      observation: {
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        isError: event.isError,
        result: excerpt(event.content),
        details: event.details ?? null,
      },
    });
  });
  pi.on("agent_end", (event) => {
    feedback({
      scope: "task",
      note: "Pi run ended; user acceptance is unknown. This is a trajectory outcome, not individual-model credit.",
      observation: {
        sessionId,
        turns,
        finalMessage: excerpt(textOf(event.messages.at(-1) ?? { content: [] })),
      },
    });
  });
  pi.on("session_shutdown", () => {
    store?.close();
    store = undefined;
  });
  pi.registerCommand("cynosure-feedback", {
    description: "Record an actual acceptance, correction, or test result for subsequent routing",
    handler: async (note, ctx) => {
      if (!active || !note.trim()) {
        ctx.ui.notify("No active Cynosure result or empty feedback", "warning");
        return;
      }
      feedback({ source: "user", scope: "task", note });
      ctx.ui.notify("Feedback recorded; it will inform subsequent decisions", "info");
    },
  });

  const modelInfo = (id, maxTokens) => ({
    id,
    name: id === "auto" ? "Cynosure · adaptive coding" : id,
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
  });
  pi.registerProvider("cynosure", {
    api: "cynosure-pi",
    baseUrl: config.router.baseUrl,
    apiKey: `$${config.router.apiKeyEnv}`,
    models: [
      { ...modelInfo("auto", 262144), api: "cynosure-pi" },
      ...config.routes.map((route) => ({
        ...modelInfo(route.id, Math.min(262144, route.outputTokenLimit ?? 262144)),
        api: "cynosure-pi",
      })),
    ],
    streamSimple: (model, context, options = {}) => {
      const stream = createAssistantMessageEventStream();
      const empty = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: "pending",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: empty });
      (async () => {
        const db = open(),
          completions = new Map();
        const task = {
          id: randomUUID(),
          scope,
          sessionId,
          prompt:
            userPrompt ||
            context.messages
              .filter((m) => m.role === "user")
              .map(textOf)
              .at(-1) ||
            "Continue coding task",
          goal: "Complete the user's coding task. Select useful next actions from real evidence. Preserve quality and delivery; reduce total cost, latency and wasted tool calls when outcomes support it.",
          budgetMicroUsd: budget,
          context: {
            sessionId,
            turn: ++turns,
            latestHostState: excerpt(context.messages.slice(-6)),
            tools: (context.tools ?? []).map((t) => t.name),
          },
        };
        const generate = async (_task, route, runId) => {
          let usage = null,
            buffer = "",
            done = false;
          const observeFetch = async (url, init) => {
            const response = await fetch(url, init);
            if (!response.ok || !response.body) return response;
            const decoder = new TextDecoder();
            const body = response.body.pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  buffer += decoder.decode(chunk, { stream: true });
                  const lines = buffer.split(/\r?\n/);
                  buffer = lines.pop() ?? "";
                  for (const line of lines)
                    if (line.startsWith("data:")) {
                      const data = line.slice(5).trim();
                      if (data === "[DONE]") {
                        done = true;
                        continue;
                      }
                      try {
                        const event = JSON.parse(data);
                        if (event.usage) usage = event.usage;
                      } catch {}
                    }
                  controller.enqueue(chunk);
                },
              }),
            );
            return new Response(body, { status: response.status, headers: response.headers });
          };
          const upstream = {
            ...modelInfo(route.id, Math.min(262144, route.outputTokenLimit ?? 262144)),
            provider: "cynosure-upstream",
            baseUrl: config.router.baseUrl,
          };
          const reply = await streamSimple(upstream, context, {
            apiKey: process.env[config.router.apiKeyEnv],
            signal: options.signal,
            maxTokens: upstream.maxTokens,
            timeoutMs: config.limits.timeoutMs,
            maxRetries: 0,
            fetch: observeFetch,
            onPayload: (payload) => {
              payload.max_tokens = upstream.maxTokens;
              payload.stream_options = { include_usage: true };
              delete payload.max_completion_tokens;
              // DeepSeek requires this field on historical assistant tool turns,
              // including turns produced by another routed model. Empty means unavailable.
              if (route.id === "deepseek-v4-flash") {
                for (const message of payload.messages ?? []) {
                  if (
                    message.role === "assistant" &&
                    message.tool_calls &&
                    message.reasoning_content === undefined
                  )
                    message.reasoning_content = "";
                }
              }
              return payload;
            },
          }).result();
          const charge = chargeOf({ usage }, route);
          if (!done || !["stop", "toolUse"].includes(reply.stopReason) || !reply.content.length) {
            db.event(task.id, "host-provider-failure", {
              route: route.id,
              stopReason: reply.stopReason,
              completedStream: done,
              charge,
              error: String(reply.errorMessage ?? "").replaceAll(
                process.env[config.router.apiKeyEnv] ?? "<missing>",
                "<redacted>",
              ),
              message: "Upstream did not provide a complete usable turn",
            });
            throw new Error("Incomplete host completion");
          }
          completions.set(runId, reply);
          return {
            output: JSON.stringify(reply.content.filter((part) => part.type !== "thinking")),
            charge,
            observation: {
              source: "pi-provider",
              stopReason: reply.stopReason,
              proposedToolCalls: reply.content.filter((part) => part.type === "toolCall").length,
              executedToolCalls: 0,
              taskOutcome: "unknown",
            },
          };
        };
        let result = null;
        if (model.id === "auto") {
          result = await new Cynosure(config, db, { generate }).run(task);
        } else {
          const route = config.routes.find((r) => r.id === model.id);
          if (!route) throw new Error("Model is not configured");
          db.create(task, config, [route]);
          const call = db.reserve(task.id, "generation", route),
            start = performance.now(),
            runId = randomUUID();
          try {
            const reply = await generate(task, route, runId);
            const settled = db.settle(
              call,
              reply.charge,
              Math.round(performance.now() - start),
              null,
            );
            db.event(task.id, "run", {
              id: runId,
              route: route.id,
              revision: route.revision,
              callId: call.id,
              status: "complete",
              output: reply.output,
              error: null,
              elapsedMs: settled.elapsedMs,
              charge: reply.charge,
              toolCalls: null,
              observationScope: "request",
              observation: reply.observation,
            });
            result = {
              taskId: task.id,
              status: "delivered",
              output: reply.output,
              selectedRunId: runId,
              selectedModel: route.id,
              evidenceIds: [],
              runIds: [runId],
              totals: db.totals(task.id),
              error: null,
            };
          } catch {
            db.settle(
              call,
              { microUsd: null, basis: "unknown", inputTokens: null, outputTokens: null },
              Math.round(performance.now() - start),
              "Host generation failed",
            );
            result = {
              taskId: task.id,
              status: "failed",
              output: null,
              selectedRunId: null,
              selectedModel: null,
              evidenceIds: [],
              runIds: [],
              totals: db.totals(task.id),
              error: "Host generation failed",
            };
          }
          db.finish(result);
        }
        active = result;
        const reply = completions.get(result.selectedRunId);
        if (!reply) throw new Error(result.error ?? "No complete coding turn");
        // Include all paid routing/candidate calls in Pi's totals, not just the chosen answer.
        const calls = db.db
          .prepare("SELECT body FROM calls WHERE task_id=?")
          .all(task.id)
          .map((r) => JSON.parse(r.body));
        const usage = zeroUsage();
        for (const call of calls) {
          usage.input += call.charge.inputTokens ?? 0;
          usage.output += call.charge.outputTokens ?? 0;
        }
        usage.totalTokens = usage.input + usage.output;
        usage.cost.total = (result.totals.reportedMicroUsd + result.totals.estimatedMicroUsd) / 1e6;
        usage.cost.output = usage.cost.total;
        const output = {
          ...reply,
          usage,
        };
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      })().catch(() => {
        const error = {
          ...empty,
          stopReason: options.signal?.aborted ? "aborted" : "error",
          errorMessage: "Cynosure could not complete this turn; see the local experience ledger.",
        };
        stream.push({ type: "error", reason: error.stopReason, error });
        stream.end();
      });
      return stream;
    },
  });
}
