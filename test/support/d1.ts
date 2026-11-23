// The slice of D1 the sync Worker uses (worker/sync.ts `SqlDb`), on an
// in-memory bun:sqlite database with the real migrations applied.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlDb, SqlStatement } from "../../worker/sync";

const MIGRATIONS = join(import.meta.dir, "../../migrations");

class Statement implements SqlStatement {
  constructor(
    private db: Database,
    private sql: string,
    private args: SQLQueryBindings[] = [],
  ) {}
  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values as SQLQueryBindings[]);
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...this.args) as T[] };
  }
  run(): { meta: { changes: number } } {
    return { meta: { changes: this.db.query(this.sql).run(...this.args).changes } };
  }
}

export function sqliteD1(): SqlDb & { sqlite: Database } {
  const sqlite = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  return {
    sqlite,
    prepare: (sql) => new Statement(sqlite, sql),
    // D1 runs a batch as one transaction.
    batch: async (stmts) => sqlite.transaction(() => stmts.map((s) => (s as Statement).run()))(),
  };
}
