// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { integer, text } from "./config.ts";
import { digest, vector } from "./store-utils.ts";
import type {
  Call,
  Charge,
  Config,
  Experience,
  Feedback,
  Model,
  Result,
  Task,
  Totals,
} from "./types.ts";
import { UNKNOWN_CHARGE } from "./types.ts";

export { digest, embeddingSpace, vector } from "./store-utils.ts";
export interface SyncDatabase {
  prepare(sql: string): {
    get(...args: (string | number | null)[]): Record<string, unknown> | undefined;
    all(...args: (string | number | null)[]): Record<string, unknown>[];
    run(...args: (string | number | null)[]): unknown;
  };
  exec(sql: string): unknown;
  transaction<T>(fn: () => T): T;
  close(): void;
}
export class CoreStore {
  readonly db: SyncDatabase;
  constructor(db: SyncDatabase) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, scope TEXT NOT NULL, created TEXT NOT NULL,
        status TEXT NOT NULL, body TEXT NOT NULL, candidates TEXT NOT NULL, config_digest TEXT NOT NULL,
        result TEXT, embedding_space TEXT, embedding TEXT, dimensions INTEGER);
      CREATE INDEX IF NOT EXISTS task_scope ON tasks(scope,created,status);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        reservation INTEGER NOT NULL, committed INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS call_task ON calls(task_id);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL, created TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_task ON events(task_id,kind,seq);
      CREATE TABLE IF NOT EXISTS embeddings(scope TEXT NOT NULL, space TEXT NOT NULL, hash TEXT NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(scope,space,hash));
      CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(id UNINDEXED, text, tokenize='trigram');
    `);
  }
  close() {
    this.db.close();
  }
  create(task: Task, config: Config, candidates: Model[]) {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO tasks(id,scope,created,status,body,candidates,config_digest) VALUES(?,?,?,'running',?,?,?)",
        )
        .run(
          task.id,
          task.scope,
          now,
          JSON.stringify(task),
          JSON.stringify(candidates),
          digest(config),
        );
      this.db
        .prepare("INSERT INTO task_fts(id,text) VALUES(?,?)")
        .run(task.id, `${task.prompt}\n${task.goal}`);
    });
  }
  task(id: string): Task {
    const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id);
    if (!row) throw new Error("Task not found");
    return JSON.parse(String(row.body));
  }
  event(taskId: string, kind: string, body: unknown) {
    this.db
      .prepare("INSERT INTO events(task_id,kind,created,body) VALUES(?,?,?,?)")
      .run(taskId, kind, new Date().toISOString(), JSON.stringify(body));
  }
  events<T>(taskId: string, kind: string): T[] {
    return this.db
      .prepare("SELECT body FROM events WHERE task_id=? AND kind=? ORDER BY seq")
      .all(taskId, kind)
      .map((row) => JSON.parse(String(row.body)) as T);
  }
  reserve(taskId: string, kind: Call["kind"], model: Model): Call {
    return this.db.transaction(() => {
      const state = this.db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId);
      if (state?.status !== "running") throw new Error("Task is not running");
      if (
        this.totals(taskId).committedMicroUsd + model.reserveMicroUsd >
        this.task(taskId).budgetMicroUsd
      )
        throw new Error("Budget exhausted");
      const call: Call = {
        id: randomUUID(),
        taskId,
        kind,
        model: model.id,
        revision: model.revision,
        reservation: model.reserveMicroUsd,
        state: "reserved",
        charge: UNKNOWN_CHARGE,
        elapsedMs: 0,
        error: null,
      };
      this.db
        .prepare("INSERT INTO calls VALUES(?,?,?,?,?)")
        .run(call.id, taskId, call.reservation, call.reservation, JSON.stringify(call));
      return call;
    });
  }
  settle(call: Call, charge: Charge, elapsedMs: number, error: string | null) {
    if (charge.microUsd !== null) integer(charge.microUsd, "charge", 0, Number.MAX_SAFE_INTEGER);
    const updated: Call = { ...call, charge, elapsedMs, state: error ? "failed" : "ok", error };
    // Unreported/estimated bills keep their reservation. Missing usage is never free.
    const committed =
      charge.basis === "reported"
        ? (charge.microUsd ?? call.reservation)
        : Math.max(call.reservation, charge.microUsd ?? 0);
    this.db
      .prepare("UPDATE calls SET committed=?,body=? WHERE id=?")
      .run(committed, JSON.stringify(updated), call.id);
    return updated;
  }
  totals(taskId: string): Totals {
    const rows = this.db.prepare("SELECT committed,body FROM calls WHERE task_id=?").all(taskId);
    const result: Totals = {
      reportedMicroUsd: 0,
      estimatedMicroUsd: 0,
      unknownCalls: 0,
      committedMicroUsd: 0,
      calls: rows.length,
    };
    for (const row of rows) {
      const c = JSON.parse(String(row.body)) as Call;
      result.committedMicroUsd += Number(row.committed);
      if (c.charge.basis === "reported") result.reportedMicroUsd += c.charge.microUsd ?? 0;
      else if (c.charge.basis === "estimated") result.estimatedMicroUsd += c.charge.microUsd ?? 0;
      else result.unknownCalls++;
    }
    return result;
  }
  finish(result: Result) {
    this.db
      .prepare("UPDATE tasks SET status=?,result=? WHERE id=? AND status='running'")
      .run(result.status, JSON.stringify(result), result.taskId);
  }
  feedback(taskId: string, input: Feedback) {
    this.task(taskId);
    if (
      !["met", "partial", "unmet", "unknown"].includes(input.verdict) ||
      !["request", "task"].includes(input.scope)
    )
      throw new Error("Invalid feedback");
    text(input.source, "feedback source", 200);
    text(input.note, "feedback note");
    if (input.toolCalls !== undefined) integer(input.toolCalls, "toolCalls");
    if (
      input.runId !== undefined &&
      !this.events<{ id: string }>(taskId, "run").some((r) => r.id === input.runId)
    )
      throw new Error("Unknown feedback run");
    this.event(taskId, "feedback", { ...input, receivedAt: new Date().toISOString() });
  }
  cachedEmbedding(scope: string, space: string, query: string): number[] | null {
    const row = this.db
      .prepare("SELECT body FROM embeddings WHERE scope=? AND space=? AND hash=?")
      .get(scope, space, digest(query));
    return row ? vector(JSON.parse(String(row.body))) : null;
  }
  saveEmbedding(taskId: string, space: string, query: string, values: number[]) {
    vector(values);
    const task = this.task(taskId),
      body = JSON.stringify(values);
    this.db
      .prepare("INSERT OR REPLACE INTO embeddings VALUES(?,?,?,?)")
      .run(task.scope, space, digest(query), body);
    this.db
      .prepare("UPDATE tasks SET embedding_space=?,embedding=?,dimensions=? WHERE id=?")
      .run(space, body, values.length, taskId);
  }
  experience(id: string): Experience {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!row) throw new Error("Experience not found");
    const task = JSON.parse(String(row.body)) as Task;
    return {
      id,
      prompt: task.prompt,
      goal: task.goal,
      createdAt: String(row.created),
      status: String(row.status),
      candidates: JSON.parse(String(row.candidates)),
      runs: this.events(id, "run"),
      evaluations: this.events(id, "evaluation"),
      feedback: this.events(id, "feedback"),
      totals: this.totals(id),
    };
  }
  vectorNeighbors(
    task: Task,
    space: string,
    values: number[],
    since: string,
    limit: number,
  ): string[] {
    return this.db
      .prepare(`SELECT id FROM tasks WHERE scope=? AND id<>? AND status<>'running' AND created>=?
      AND embedding_space=? AND dimensions=? ORDER BY vec_distance_cosine(embedding,?),created DESC LIMIT ?`)
      .all(task.scope, task.id, since, space, values.length, JSON.stringify(values), limit)
      .map((r) => String(r.id));
  }
  search(
    task: Task,
    space: string,
    values: number[] | null,
    options: Config["memory"],
  ): Experience[] {
    const since = new Date(Date.now() - options.maxAgeDays * 86_400_000).toISOString();
    const rankings: string[][] = [];
    if (values) {
      vector(values);
      rankings.push(this.vectorNeighbors(task, space, values, since, options.topK * 4));
    }
    const terms = [...new Set((task.prompt.match(/[\p{L}\p{N}_]{3,}/gu) ?? []).slice(0, 12))];
    if (terms.length) {
      rankings.push(
        this.db
          .prepare(`SELECT t.id FROM task_fts f JOIN tasks t ON t.id=f.id
        WHERE task_fts MATCH ? AND t.scope=? AND t.id<>? AND t.status<>'running' AND t.created>=?
        ORDER BY bm25(task_fts),t.created DESC LIMIT ?`)
          .all(
            terms.map((x) => `"${x}"`).join(" OR "),
            task.scope,
            task.id,
            since,
            options.topK * 4,
          )
          .map((r) => String(r.id)),
      );
    }
    // Reciprocal rank fusion ranks case relevance only; it never scores model quality.
    const ranks = new Map<string, number>();
    for (const ranking of rankings)
      ranking.forEach((id, i) => {
        ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + i + 1));
      });
    return [...ranks]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, options.topK)
      .map(([id]) => this.experience(id));
  }
}
