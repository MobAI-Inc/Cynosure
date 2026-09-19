// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2]);
const plan = JSON.parse(readFileSync(`${root}/plan.json`, "utf8"));
const runtime = JSON.parse(readFileSync(`${root}/runtime.json`, "utf8"));
const cases = JSON.parse(readFileSync(`${root}/cases.json`, "utf8"));
const adapter = `file://${resolve("scripts/eval/provider.mjs")}`;
const provider = (mode, model, phase) => ({
  id: adapter,
  label: mode === "cynosure" ? "Cynosure" : model,
  config: { root, mode, model, phase },
});
for (const phase of [
  "learn",
  ...Array.from({ length: plan.repetitions }, (_, i) => `heldout-${i + 1}`),
]) {
  const providers = runtime.routes.map((m) => provider("fixed", m.id, phase));
  if (phase.startsWith("heldout")) providers.push(provider("cynosure", undefined, phase));
  const tests = cases
    .filter((c) => c.split === (phase === "learn" ? "learn" : "heldout"))
    .map((c) => ({
      description: c.id,
      vars: { caseId: c.id, question: c.question },
      metadata: { scenario: c.id },
      assert: [
        {
          type: "javascript",
          value: "context.providerResponse.metadata.finalPass === true",
          metric: "official_tests_pass",
        },
      ],
    }));
  if (phase === "heldout-2") {
    providers.reverse();
    tests.reverse();
  }
  const config = {
    description: `${plan.version}: ${phase}`,
    prompts: ["{{question}}"],
    providers,
    tests,
    extensions: [`file://${resolve("scripts/eval/hooks.mjs")}:afterEach`],
    evaluateOptions: { maxConcurrency: plan.maxConcurrency },
  };
  writeFileSync(`${root}/${phase}.config.json`, JSON.stringify(config, null, 2));
}
console.log(
  JSON.stringify({
    learning: cases.filter((c) => c.split === "learn").length,
    heldout: cases.filter((c) => c.split === "heldout").length,
    providers: runtime.routes.map((m) => m.id),
  }),
);
