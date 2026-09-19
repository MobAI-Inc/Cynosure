// SPDX-License-Identifier: Apache-2.0
import { object } from "./config.ts";
import type { CoreStore as Store } from "./store-core.ts";
import { vector } from "./store-utils.ts";
import type { Call, Charge, ChoiceAnswer, ChoiceQuestion, Config, Model } from "./types.ts";
import { UNKNOWN_CHARGE } from "./types.ts";

export class CallError extends Error {
  readonly call: Call;
  constructor(message: string, call: Call) {
    super(message);
    this.call = call;
  }
}
const tokens = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
export const generationBody = (
  model: Model,
  messages: Array<{ role: string; content: string }>,
) => ({
  model: model.id,
  messages,
  max_tokens: Math.min(262_144, model.outputTokenLimit ?? 262_144),
  stream: true,
  stream_options: { include_usage: true },
});

// Transport streaming avoids idle gateway timeouts; only a completed answer is delivered.
function completionFromStream(source: string): Record<string, unknown> {
  let content = "",
    finish: unknown = null,
    usage: unknown,
    done = false,
    invalid = false;
  for (const frame of source.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    if (done) {
      invalid = true;
      continue;
    }
    const event = object(JSON.parse(data));
    if (event.usage) usage = event.usage;
    if (event.error) invalid = true;
    if (!Array.isArray(event.choices)) {
      invalid = true;
      continue;
    }
    for (const value of event.choices) {
      const choice = object(value),
        delta = object(choice.delta ?? {});
      if (choice.index !== 0 || delta.tool_calls || delta.function_call) invalid = true;
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== "string") invalid = true;
        else content += delta.content;
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined)
        finish = choice.finish_reason;
    }
  }
  return {
    choices: [
      { finish_reason: done && !invalid ? finish : "incomplete_stream", message: { content } },
    ],
    ...(usage ? { usage } : {}),
  };
}
export function chargeOf(
  payload: Record<string, unknown>,
  model: Model,
  kind: Call["kind"] = "generation",
): Charge {
  const u = payload.usage && typeof payload.usage === "object" ? object(payload.usage) : {};
  const inputTokens = tokens(
    u.prompt_tokens ?? u.input_tokens ?? (kind === "embedding" ? u.total_tokens : undefined),
  );
  const outputTokens = kind === "embedding" ? 0 : tokens(u.completion_tokens ?? u.output_tokens);
  const details =
    u.cost && typeof u.cost === "object" && !Array.isArray(u.cost) ? object(u.cost) : {};
  const cost = typeof u.cost === "number" ? u.cost : (u.cost_usd ?? details.total_cost_usd);
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= 1e6)
    return {
      microUsd: Math.ceil(cost * 1e6),
      basis: details.estimated === true ? "estimated" : "reported",
      inputTokens,
      outputTokens,
    };
  if (
    model.pricing &&
    inputTokens !== null &&
    (outputTokens !== null || model.pricing.output === 0)
  ) {
    const amount =
      (BigInt(inputTokens) * BigInt(model.pricing.input) +
        BigInt(outputTokens ?? 0) * BigInt(model.pricing.output) +
        999_999n) /
      1_000_000n;
    if (amount <= BigInt(Number.MAX_SAFE_INTEGER))
      return { microUsd: Number(amount), basis: "estimated", inputTokens, outputTokens };
  }
  return { ...UNKNOWN_CHARGE, inputTokens, outputTokens };
}
export function decodeChoices(
  payload: Record<string, unknown>,
  questions: Record<string, ChoiceQuestion>,
): Record<string, ChoiceAnswer> {
  const answers = object(payload.answers),
    result: Record<string, ChoiceAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = object(answers[name]),
      probabilities = object(answer.probabilities);
    const keys = Object.keys(question.criteria).sort();
    if (
      answer.type !== "choice" ||
      typeof answer.choice !== "string" ||
      !Object.hasOwn(question.criteria, answer.choice)
    )
      throw new Error("Invalid Jev choice");
    if (Object.keys(probabilities).sort().join("\0") !== keys.join("\0"))
      throw new Error("Invalid Jev options");
    const values = keys.map((k) => probabilities[k]);
    if (
      values.some((p) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) ||
      Math.abs(values.reduce<number>((s, p) => s + Number(p), 0) - 1) > keys.length * 0.005 + 1e-6
    )
      throw new Error("Invalid Jev probabilities");
    if (
      answer.confidence !== undefined &&
      (typeof answer.confidence !== "number" ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1)
    )
      throw new Error("Invalid Jev confidence");
    result[name] = {
      type: "choice",
      choice: answer.choice,
      probabilities: probabilities as Record<string, number>,
      ...(answer.confidence === undefined ? {} : { confidence: Number(answer.confidence) }),
    };
  }
  return result;
}

export class Providers {
  readonly config: Config;
  readonly store: Store;
  readonly fetchImpl: typeof fetch;
  readonly env: NodeJS.ProcessEnv;
  constructor(
    config: Config,
    store: Store,
    fetchImpl: typeof fetch = fetch,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.config = config;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.env = env;
  }
  credentials() {
    for (const name of [this.config.router.apiKeyEnv])
      if (!this.env[name]) throw new Error(`Missing credential environment variable: ${name}`);
  }
  async post<T>(
    taskId: string,
    kind: Call["kind"],
    model: Model,
    url: string,
    keyEnv: string,
    body: unknown,
    decode: (body: Record<string, unknown>) => T,
  ): Promise<{ value: T; call: Call; raw: Record<string, unknown> }> {
    const key = this.env[keyEnv];
    if (!key) throw new Error(`Missing credential environment variable: ${keyEnv}`);
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > model.maxInputBytes)
      throw new Error(`Input exceeds ${kind} limit`);
    const call = this.store.reserve(taskId, kind, model),
      start = performance.now();
    let charge = UNKNOWN_CHARGE;
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: encoded,
        signal: AbortSignal.timeout(this.config.limits.timeoutMs),
      });
      if (!response.body) throw new Error("Empty HTTP body");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > this.config.limits.maxResponseBytes) throw new Error("Response exceeds limit");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      let raw: Record<string, unknown>;
      try {
        const source = Buffer.concat(chunks).toString("utf8");
        raw =
          response.ok && response.headers.get("content-type")?.includes("text/event-stream")
            ? completionFromStream(source)
            : object(JSON.parse(source));
      } catch {
        throw new Error(response.ok ? "Invalid provider JSON" : `HTTP ${response.status}`);
      }
      charge = chargeOf(raw, model, kind);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (charge.microUsd !== null && charge.microUsd > call.reservation)
        throw new Error("Provider cost exceeds reservation");
      const value = decode(raw);
      return {
        value,
        raw,
        call: this.store.settle(call, charge, Math.round(performance.now() - start), null),
      };
    } catch (error) {
      // Fixed diagnostics only: transport errors may contain URLs or private provider payloads.
      const message =
        error instanceof Error &&
        /^(HTTP \d+|Invalid Jev|Expected object|Empty HTTP body|Response exceeds limit|Provider cost exceeds reservation|Incomplete completion|Invalid embedding|Invalid completion|Invalid judge)/.test(
          error.message,
        )
          ? error.message
          : "Provider request failed";
      throw new CallError(
        message,
        this.store.settle(call, charge, Math.round(performance.now() - start), message),
      );
    }
  }
  async embed(taskId: string, input: string) {
    return this.post(
      taskId,
      "embedding",
      this.config.embedding,
      `${this.config.router.baseUrl}/embeddings`,
      this.config.router.apiKeyEnv,
      { model: this.config.embedding.id, input, encoding_format: "float" },
      (raw) => {
        if (!Array.isArray(raw.data) || raw.data.length !== 1)
          throw new Error("Invalid embedding response");
        const item = object(raw.data[0]);
        if (item.index !== 0) throw new Error("Invalid embedding index");
        return vector(item.embedding);
      },
    );
  }
  async decide(taskId: string, state: unknown, questions: Record<string, ChoiceQuestion>) {
    return this.post(
      taskId,
      "decision",
      this.config.jev,
      `${this.config.router.baseUrl}/decisions`,
      this.config.router.apiKeyEnv,
      { model: this.config.jev.id, state, questions },
      (raw) => decodeChoices(raw, questions),
    );
  }
  async generate(
    taskId: string,
    model: Model,
    messages: Array<{ role: string; content: string }>,
    kind: "generation" | "judge" = "generation",
  ) {
    return this.post(
      taskId,
      kind,
      model,
      `${this.config.router.baseUrl}/chat/completions`,
      this.config.router.apiKeyEnv,
      generationBody(model, messages),
      (raw) => {
        if (!Array.isArray(raw.choices) || raw.choices.length !== 1)
          throw new Error("Invalid completion choices");
        const choice = object(raw.choices[0]),
          message = object(choice.message);
        if (choice.finish_reason !== "stop") throw new Error("Incomplete completion");
        if (typeof message.content !== "string" || !message.content.trim() || message.tool_calls)
          throw new Error("Invalid completion content");
        return message.content;
      },
    );
  }
}
