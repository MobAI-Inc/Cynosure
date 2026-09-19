// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : path.endsWith(".md") ? [path] : [];
  });
}
const documents = [
  ...[
    "README.md",
    "README.zh-CN.md",
    "ROADMAP.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "eval/README.md",
  ].map((p) => join(root, p)),
  ...markdownFiles(join(root, "docs")),
];
const failures = [];
let links = 0;
for (const path of documents) {
  const source = readFileSync(path, "utf8").replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  for (const match of source.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("#")) continue;
    const local = decodeURIComponent(target.split("#")[0]);
    if (!local) continue;
    links++;
    const destination = resolve(dirname(path), local);
    if (isAbsolute(local) || relative(root, destination).startsWith("..")) {
      failures.push(`${relative(root, path)}: nonportable local link ${target}`);
    } else if (!existsSync(destination)) {
      failures.push(`${relative(root, path)}: missing ${target}`);
    }
  }
}
assert.deepEqual(failures, [], "Documentation links must resolve within the source tree");

const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const manifest = json("package.json");
const evidence = json("docs/benchmarks/evidence.json");
assert.equal(evidence.implementation_version, manifest.version, "Review evidence for this version");
for (const source of Object.values(evidence.sources)) {
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  assert.ok(source.recorded_at);
}
const { unique_heldout_scenarios: cases, repeats_per_scenario: repeats, arms } = evidence.coding;
for (const [name, arm] of Object.entries(arms)) {
  assert.equal(arm.n, cases * repeats, `${name}: inconsistent trial denominator`);
  assert.ok(arm.finalPass >= 0 && arm.finalPass <= arm.n, `${name}: invalid pass count`);
  assert.ok(Number.isInteger(arm.unknownCalls) && arm.unknownCalls >= 0);
}
assert.equal(
  evidence.pi.groups.reduce((sum, group) => sum + group.completed, 0),
  evidence.pi.formal_trajectories,
  "Pi group totals must match formal trajectories",
);
const sources = json("docs/research/sources.json");
for (const source of sources.files) {
  assert.match(source.revision, /^[a-f0-9]{40}$/);
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  assert.ok(source.url.includes(`/blob/${source.revision}/`), "Upstream links must pin a commit");
}
console.log(
  `${documents.length} documents, ${links} local links, evidence denominators and ${sources.files.length} pinned source records passed.`,
);
