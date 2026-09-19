#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, parseTask } from "./config.ts";
import { Cynosure } from "./router.ts";
import { Store } from "./store.ts";
import type { Feedback } from "./types.ts";

process.umask(0o077);
const [command, ...args] = process.argv.slice(2);
const read = (file: string | undefined) => {
  if (!file) throw new Error("Missing JSON input path");
  return JSON.parse(readFileSync(resolve(file), "utf8"));
};
let store: Store | undefined;
try {
  if (command === "run") {
    const [configFile, taskFile, db = ".cynosure/experience.sqlite"] = args;
    const config = parseConfig(read(configFile)),
      task = parseTask(read(taskFile));
    store = new Store(resolve(db));
    const result = await new Cynosure(config, store).run(task);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "delivered") process.exitCode = 1;
  } else if (command === "inspect") {
    const [id, db = ".cynosure/experience.sqlite"] = args;
    if (!id) throw new Error("Missing task id");
    store = new Store(resolve(db));
    console.log(
      JSON.stringify(
        {
          experience: store.experience(id),
          totals: store.totals(id),
          decisions: store.events(id, "decision"),
        },
        null,
        2,
      ),
    );
  } else if (command === "feedback") {
    const [id, file, db = ".cynosure/experience.sqlite"] = args;
    if (!id) throw new Error("Missing task id");
    store = new Store(resolve(db));
    store.feedback(id, read(file) as Feedback);
    console.log(JSON.stringify({ taskId: id, feedbackRecorded: true }));
  } else {
    console.log(
      "cynosure run <config.json> <task.json> [database]\ncynosure inspect <task-id> [database]\ncynosure feedback <task-id> <feedback.json> [database]",
    );
    if (command && command !== "--help") process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cynosure failed");
  process.exitCode = 1;
} finally {
  store?.close();
}
