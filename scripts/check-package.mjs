// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.env.npm_execpath;
assert.ok(npm, "Run via npm run check:package");
const temp = mkdtempSync(join(tmpdir(), "cynosure-package-"));
const node = (args, cwd = temp) =>
  execFileSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
try {
  const [packed] = JSON.parse(node([npm, "pack", "--json", "--pack-destination", temp], root));
  const paths = packed.files.map((f) => f.path);
  const modules = readdirSync(join(root, "src"))
    .filter((p) => p.endsWith(".ts"))
    .map((p) => p.slice(0, -3));
  assert.deepEqual(
    paths.filter((p) => p.startsWith("dist/")).sort(),
    modules.flatMap((p) => [`dist/${p}.js`, `dist/${p}.d.ts`]).sort(),
  );
  for (const path of paths)
    assert.doesNotMatch(
      path,
      /(?:^reports\/|^examples\/|^docs\/reviews\/|\.local\.json$|\.sqlite|\.env|^config\/(?!router\.example\.json$|task\.example\.json$|feedback\.example\.json$))/u,
    );
  writeFileSync(join(temp, "package.json"), '{"type":"module","private":true}\n');
  node([
    npm,
    "install",
    "--prefer-offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(temp, packed.filename),
  ]);
  writeFileSync(
    join(temp, "smoke.mjs"),
    `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store, parseConfig } from 'cynosure';
const config=parseConfig(JSON.parse(readFileSync(new URL('./node_modules/cynosure/config/router.example.json',import.meta.url),'utf8')));
assert.deepEqual(config.routes.map(m=>m.id),['grok-4.6','deepseek-v4-flash','glm-5.3','glm-5.3-flash']);
const db=new Store(':memory:');
assert.ok(db.db.prepare('select vec_version() v').get().v);
db.close();
`,
  );
  node(["smoke.mjs"]);
  assert.match(node(["node_modules/cynosure/dist/cli.js", "--help"]), /cynosure run/);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  console.log(
    `${manifest.name}@${manifest.version}: packed runtime, native vector extension, CLI and publication boundaries passed.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
