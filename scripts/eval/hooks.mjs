// SPDX-License-Identifier: Apache-2.0
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export function afterEach(context) {
  const root = process.env.CYNOSURE_EVAL_DIR,
    phase = process.env.CYNOSURE_EVAL_PHASE;
  if (!root || !phase) throw new Error("Missing experiment context");
  appendFileSync(join(root, `${phase}.rows.jsonl`), `${JSON.stringify(context.result)}\n`, {
    mode: 0o600,
  });
}
