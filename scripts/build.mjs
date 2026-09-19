// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 MOBAI

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// dist is generated: remove outputs for renamed or deleted source modules as well.
rmSync(join(root, "dist"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
