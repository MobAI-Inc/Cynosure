// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { chargeOf, decodeChoices, generationBody, Providers } from "../src/providers.ts";
import { Cynosure } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { config, env, fakeFetch, first, task } from "./fixtures.ts";

test("generation token allowance is fixed, not a model configuration knob", () => {
  const c = config();
  assert.ok(!Object.hasOwn(first(parseConfig(c).routes), "maxOutputTokens"));
  const legacy = { ...c, routes: [{ ...first(c.routes), maxOutputTokens: 8192 }] };
  assert.throws(() => parseConfig(legacy), /generation uses 262144/);
  assert.equal(generationBody(first(c.routes), []).max_tokens, 262144);
  assert.equal(
    generationBody({ ...first(c.routes), outputTokenLimit: 131072 }, []).max_tokens,
    131072,
  );
});

test("reported, estimated and missing usage remain distinguishable", () => {
  const m = {
    ...first(config().routes),
    pricing: { input: 500000, output: 1000000, source: "fixture" },
  };
  assert.deepEqual(chargeOf({ usage: { prompt_tokens: 100, completion_tokens: 20 } }, m), {
    microUsd: 70,
    basis: "estimated",
    inputTokens: 100,
    outputTokens: 20,
  });
  assert.equal(chargeOf({ usage: { cost: 0 } }, m).basis, "reported");
  assert.equal(chargeOf({}, m).microUsd, null);
  assert.equal(chargeOf({ usage: { cost: -1 } }, m).basis, "unknown");
  assert.equal(
    chargeOf({ usage: { total_tokens: 120, completion_tokens: 20 } }, m).basis,
    "unknown",
  );
  assert.equal(chargeOf({ usage: { total_tokens: 120 } }, m, "embedding").microUsd, 60);
});
test("native explicit Choice is preserved instead of recomputing rounded argmax", () => {
  const q = {
    action: {
      type: "choice" as const,
      instructions: "choose",
      criteria: { a: "first", b: "second" },
    },
  };
  const a = decodeChoices(
    { answers: { action: { type: "choice", choice: "b", probabilities: { a: 0.505, b: 0.495 } } } },
    q,
  );
  assert.equal(a.action?.choice, "b");
  assert.throws(
    () =>
      decodeChoices(
        { answers: { action: { type: "choice", choice: "a", probabilities: { a: 1, b: 1 } } } },
        q,
      ),
    /Invalid Jev probabilities/,
  );
});
test("local HTTP integration exercises real fetch, bounded responses and native wire contracts", async () => {
  const mock = fakeFetch();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.authorization, `Bearer ${env.TEST_ROUTER_KEY}`);
    const response = await mock.fetch(`http://localhost${req.url}`, {
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const c = config();
  c.router.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const db = new Store(":memory:");
  try {
    const result = await new Cynosure(c, db, { env }).run(task());
    assert.equal(result.status, "delivered");
    assert.equal(result.runIds.length, 2);
    assert.ok(mock.bodies.some((b) => b.encoding_format === "float"));
    assert.ok(
      mock.bodies
        .filter((b) => b.url.endsWith("/decisions"))
        .every((b) => b.questions.action?.type === "choice"),
    );
  } finally {
    db.close();
    server.close();
    await once(server, "close");
  }
});
test("oversize response retains unknown reservation instead of trusting partial usage", async () => {
  const c = config();
  c.limits.maxResponseBytes = 1000;
  const db = new Store(":memory:");
  db.create(task(), c, c.routes);
  try {
    const p = new Providers(
      c,
      db,
      (async () => new Response("a".repeat(2000))) as typeof fetch,
      env,
    );
    await assert.rejects(() => p.embed("task", "text"), /Response exceeds limit/);
    assert.equal(db.totals("task").unknownCalls, 1);
    assert.equal(db.totals("task").committedMicroUsd, 1000);
  } finally {
    db.close();
  }
});

test("Router cost detail preserves estimated billing", () => {
  const m = first(config().routes);
  assert.equal(
    chargeOf({ usage: { cost_usd: 0.000042, cost: { estimated: false } } }, m).microUsd,
    42,
  );
  assert.equal(
    chargeOf({ usage: { cost: { total_cost_usd: 0.000042, estimated: true } } }, m).basis,
    "estimated",
  );
});

test("paid invalid Jev answers retain reported cost on HTTP failure", async () => {
  const c = config(),
    db = new Store(":memory:");
  db.create(task(), c, c.routes);
  try {
    const p = new Providers(
      c,
      db,
      (async () =>
        Response.json(
          {
            error: { type: "decision_response_invalid" },
            usage: { input_tokens: 1000, output_tokens: 10, cost: 0.000042 },
          },
          { status: 502 },
        )) as typeof fetch,
      env,
    );
    await assert.rejects(() => p.decide("task", {}, {}), /HTTP 502/);
    assert.equal(db.totals("task").reportedMicroUsd, 42);
    assert.equal(db.totals("task").unknownCalls, 0);
  } finally {
    db.close();
  }
});

test("streamed completions preserve split UTF-8 and final usage, and require terminal success", async () => {
  const c = config();
  for (const ending of ["complete", "missing-done", "length", "error", "tool-call"]) {
    const db = new Store(":memory:");
    db.create(task(), c, c.routes);
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
    const wire =
      ": heartbeat\r\n\r\n" +
      chunk({ reasoning_content: "private reasoning" }) +
      chunk({ content: "完整代码" }) +
      (ending === "tool-call" ? chunk({ tool_calls: [{ id: "tool" }] }) : "") +
      chunk({}, ending === "length" ? "length" : "stop") +
      (ending === "error" ? 'data: {"error":{"message":"upstream interrupted"}}\r\n\r\n' : "") +
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.000042}}\r\n\r\n' +
      (ending === "missing-done" ? "" : "data: [DONE]\r\n\r\n");
    const bytes = new TextEncoder().encode(wire);
    const fetchImpl = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, true);
      assert.equal(body.max_tokens, 262144);
      assert.equal(body.stream_options.include_usage, true);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7)
              controller.enqueue(bytes.slice(offset, offset + 7));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      const p = new Providers(c, db, fetchImpl, env);
      if (ending === "complete") {
        const result = await p.generate("task", first(c.routes), [
          { role: "user", content: "code" },
        ]);
        assert.equal(result.value, "完整代码");
      } else
        await assert.rejects(
          () => p.generate("task", first(c.routes), []),
          /Incomplete completion/,
        );
      assert.equal(db.totals("task").reportedMicroUsd, 42);
    } finally {
      db.close();
    }
  }
});
