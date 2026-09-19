// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as vec from "sqlite-vec";
import { CoreStore } from "./store-core.ts";

export { digest, embeddingSpace, vector } from "./store-utils.ts";
export class Store extends CoreStore {
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path, { allowExtension: true });
    vec.load(db);
    db.enableLoadExtension(false);
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (![0, 1].includes(version)) {
      db.close();
      throw new Error("Unsupported database version");
    }
    super({
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      transaction: (fn) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    });
    db.exec("PRAGMA user_version=1;");
  }
}
