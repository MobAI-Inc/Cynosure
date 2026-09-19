// SPDX-License-Identifier: Apache-2.0
// Analyze recorded official-test observations; this script makes no model calls.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(process.argv[2]);
const read = (name) => JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
const plan = read("plan.json"),
  runtime = read("runtime.json");
const cases = read("cases.json").filter((c) => c.split === "heldout");
const phases = ["learn", ...Array.from({ length: plan.repetitions }, (_, i) => `heldout-${i + 1}`)];
const rows = phases.flatMap((phase) =>
  existsSync(`${root}/${phase}.rows.jsonl`)
    ? readFileSync(`${root}/${phase}.rows.jsonl`, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ phase, ...JSON.parse(line) }))
    : [],
);
const heldout = rows.filter((r) => r.phase.startsWith("heldout"));
const metadata = (r) => r.response?.metadata ?? {};
const key = (r) => `${r.phase}/${metadata(r).caseId}/${r.provider.id}`;
const keys = rows.map(key),
  unique = new Set(keys);
if (keys.length !== unique.size) throw new Error("Duplicate trial rows: refuse aggregated result");
const arms = [...runtime.routes.map((m) => m.id), "cynosure"];
const expected = phases
  .slice(1)
  .flatMap((phase) => cases.flatMap((c) => arms.map((arm) => `${phase}/${c.id}/${arm}`)));
const quantile = (values, q) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] : null;
const sum = (values) => values.reduce((a, b) => a + b, 0);
const count = (values) =>
  Object.fromEntries([...new Set(values)].map((v) => [v, values.filter((x) => x === v).length]));
const wilson = (passed, n) => {
  if (!n) return null;
  const z = 1.959963984540054,
    p = passed / n,
    den = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / den;
  const radius = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [center - radius, center + radius];
};
function metrics(records) {
  const ms = records.map(metadata),
    calls = ms.flatMap((m) => m.calls ?? []);
  const runs = ms.flatMap((m) => (m.attempts ?? []).flatMap((a) => a.runs));
  const testRuns = runs.filter((r) => r.observation);
  const passed = ms.filter((m) => m.finalPass).length;
  const executable = ms.filter((m) =>
    (m.attempts ?? []).some((a) => a.runs.some((r) => r.observation)),
  );
  const elapsed = ms.map((m) => m.elapsedMs).filter(Number.isFinite);
  return {
    n: records.length,
    firstPass: ms.filter((m) => m.firstPass).length,
    finalPass: passed,
    repaired: ms.filter((m) => !m.firstPass && m.finalPass).length,
    fallbackDeliveries: ms.reduce(
      (n, m) => n + (m.attempts ?? []).filter((a) => a.result.delivery?.via === "fallback").length,
      0,
    ),
    trialsWithExecutableCode: executable.length,
    trialsWithoutExecutableCode: records.length - executable.length,
    unsuccessfulTrialsWithExecutableCode: executable.filter((m) => !m.finalPass).length,
    descriptiveWilson95: wilson(passed, records.length),
    medianMs: quantile(elapsed, 0.5),
    p95Ms: quantile(elapsed, 0.95),
    successfulMedianMs: quantile(
      ms.filter((m) => m.finalPass).map((m) => m.elapsedMs),
      0.5,
    ),
    reportedUsd: sum(ms.map((m) => m.totals?.reportedMicroUsd ?? 0)) / 1e6,
    estimatedUsd: sum(ms.map((m) => m.totals?.estimatedMicroUsd ?? 0)) / 1e6,
    unknownCalls: sum(ms.map((m) => m.totals?.unknownCalls ?? 0)),
    generationCalls: calls.filter((c) => c.kind === "generation").length,
    decisionCalls: calls.filter((c) => c.kind === "decision").length,
    embeddingCalls: calls.filter((c) => c.kind === "embedding").length,
    callErrors: count(calls.filter((c) => c.error).map((c) => `${c.kind}: ${c.error}`)),
    outputTokenMax: Math.max(
      0,
      ...calls.filter((c) => c.kind === "generation").map((c) => c.charge.outputTokens ?? 0),
    ),
    testRuns: testRuns.length,
    passingTestRuns: testRuns.filter((r) => r.observation.allTestsPassed).length,
    failedTestRuns: testRuns.filter((r) => !r.observation.allTestsPassed).length,
    testTimeouts: testRuns.filter((r) => r.observation.exitCode === 124).length,
    testCollectionErrors: testRuns.filter((r) => r.observation.errors > 0).length,
    incompleteTrials: records.filter((r) => !r.response?.metadata?.attempts).length,
    routeCalls: count(calls.filter((c) => c.kind === "generation").map((c) => c.model)),
    selectedModels: count(
      ms.flatMap((m) => (m.finalPass ? [m.attempts.at(-1).result.selectedModel] : [])),
    ),
  };
}
const audit = {
  tasks: 0,
  initialChoices: [],
  decisions: [],
  retrievals: [],
  deliveredFailingTest: 0,
  passingOutputWithoutDelivery: 0,
  qualityAgainstTests: {},
  crossTrialEvidence: [],
};
for (const row of heldout.filter((r) => r.provider.id === "cynosure")) {
  const m = metadata(row);
  if (!m.sqlitePath || !existsSync(m.sqlitePath)) continue;
  const db = new DatabaseSync(m.sqlitePath, { readOnly: true });
  try {
    for (const attempt of m.attempts ?? []) {
      audit.tasks++;
      for (const run of attempt.runs) {
        const passed = run.observation?.allTestsPassed;
        if (attempt.result.selectedRunId === run.id && passed === false)
          audit.deliveredFailingTest++;
      }
      if (
        attempt.result.status !== "delivered" &&
        attempt.runs.some((r) => r.observation?.allTestsPassed)
      )
        audit.passingOutputWithoutDelivery++;
      for (const event of db
        .prepare(
          "SELECT kind,body FROM events WHERE task_id=? AND kind IN ('retrieval','decision') ORDER BY seq",
        )
        .all(attempt.taskId)) {
        const e = JSON.parse(event.body);
        if (event.kind === "retrieval") {
          audit.retrievals.push({
            case: m.caseId,
            taskId: attempt.taskId,
            selected: e.caseIds.length,
            retrieved: e.retrievedIds.length,
            method: e.method,
          });
          for (const id of e.caseIds)
            if (!id.startsWith("learning-") && !m.attempts.some((a) => a.taskId === id))
              audit.crossTrialEvidence.push(id);
        } else {
          const choice = e.answers.action.choice;
          if (e.stage === "initial") audit.initialChoices.push(choice);
          audit.decisions.push(choice);
          for (const [name, answer] of Object.entries(e.answers)) {
            if (!name.startsWith("quality_")) continue;
            const output = e.state.outputs[Number(name.slice(8))];
            const test = output?.observation?.allTestsPassed;
            const k = `${test === true ? "tests-pass" : test === false ? "tests-fail" : "tests-unavailable"}/${answer.choice}`;
            audit.qualityAgainstTests[k] = (audit.qualityAgainstTests[k] ?? 0) + 1;
          }
        }
      }
    }
  } finally {
    db.close();
  }
}
// Paired bootstrap resamples complete scenario clusters, retaining both repetitions.
let seed = 20260919;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const paired = {};
for (const arm of arms.filter((a) => a !== "cynosure")) {
  const clusters = cases
    .map((c) => {
      const differences = phases.slice(1).map((phase) => {
        const router = heldout.find(
          (r) => r.phase === phase && metadata(r).caseId === c.id && r.provider.id === "cynosure",
        );
        const fixed = heldout.find(
          (r) => r.phase === phase && metadata(r).caseId === c.id && r.provider.id === arm,
        );
        return router && fixed
          ? Number(metadata(router).finalPass === true) - Number(metadata(fixed).finalPass === true)
          : null;
      });
      return differences.every((v) => v !== null) ? sum(differences) / differences.length : null;
    })
    .filter((x) => x !== null);
  const estimates = clusters.length
    ? Array.from(
        { length: 10000 },
        () =>
          sum(clusters.map(() => clusters[Math.floor(random() * clusters.length)])) /
          clusters.length,
      )
    : [];
  paired[arm] = {
    completeScenarios: clusters.length,
    successRateDifference: clusters.length ? sum(clusters) / clusters.length : null,
    scenarioBootstrap95: estimates.length
      ? [quantile(estimates, 0.025), quantile(estimates, 0.975)]
      : null,
  };
}
const report = {
  generatedAt: new Date().toISOString(),
  integrity: {
    uniqueTrials: unique.size,
    missingHeldout: expected.filter((k) => !unique.has(k)),
    expectedHeldout: expected.length,
    learningRows: rows.filter((r) => r.phase === "learn").length,
  },
  complete:
    expected.every((k) => unique.has(k)) && rows.filter((r) => r.phase === "learn").length === 40,
  learning: Object.fromEntries(
    arms
      .filter((a) => a !== "cynosure")
      .map((a) => [a, metrics(rows.filter((r) => r.phase === "learn" && r.provider.id === a))]),
  ),
  heldout: Object.fromEntries(
    arms.map((a) => [a, metrics(heldout.filter((r) => r.provider.id === a))]),
  ),
  byPhase: Object.fromEntries(
    phases
      .slice(1)
      .map((p) => [
        p,
        Object.fromEntries(
          arms.map((a) => [
            a,
            metrics(heldout.filter((r) => r.phase === p && r.provider.id === a)),
          ]),
        ),
      ]),
  ),
  scenarios: cases.map((c) => ({
    case: c.id,
    arms: Object.fromEntries(
      arms.map((a) => [
        a,
        metrics(heldout.filter((r) => metadata(r).caseId === c.id && r.provider.id === a)),
      ]),
    ),
  })),
  pairedScenarioBootstrap: paired,
  routing: {
    ...audit,
    initialChoices: count(audit.initialChoices),
    decisions: count(audit.decisions),
  },
  notes: [
    "Costs omit unknown charges; token-based estimated costs are not invoices.",
    "Cynosure first pass means first routing round, which can execute several models.",
    "Wilson intervals are descriptive and ignore repeated-case dependence; paired bootstrap retains both repetitions per scenario.",
    "Small public Python subset cannot establish convergence or general repository-editing superiority.",
  ],
};
writeFileSync(`${root}/analysis.json`, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      complete: report.complete,
      trials: rows.length,
      heldout: report.heldout,
      paired: report.pairedScenarioBootstrap,
    },
    null,
    2,
  ),
);
