/**
 * A `D1Database` over `node:sqlite`, for the test suite.
 *
 * The sync takes its database as a parameter, so the tests do not need
 * Workers, wrangler, or a network — they need something that answers the D1
 * surface `db/queries.ts` actually uses: `prepare`, `bind`, `first`, `all`,
 * `run`, `batch` and `exec`. That is this file, and it is deliberately no
 * larger than that.
 *
 * `node:sqlite` rather than better-sqlite3: it is the same SQLite against the
 * same `src/db/schema.sql`, but it ships with Node, so the test suite needs no
 * native build toolchain to run.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded through createRequire rather than imported: Vite's list of Node
// builtins does not yet include `node:sqlite`, so a plain import is resolved
// as a bare package name and fails to load.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, '..', '..', 'src', 'db', 'schema.sql');

type Row = Record<string, unknown>;
type Bindable = null | number | bigint | string | Uint8Array;

/**
 * `node:sqlite` has no `reader` flag, so the statement kind is read off the
 * SQL. A `RETURNING` clause makes a write row-producing, which is exactly how
 * the header upsert and the item insert report what they actually created.
 */
function producesRows(sql: string): boolean {
  return /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const { results } = this.executeSync();
    const row = results[0];
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, number> }> {
    const { results, meta } = this.executeSync();
    return { results: results as T[], success: true, meta };
  }

  async run(): Promise<{ results: Row[]; success: true; meta: Record<string, number> }> {
    const { results, meta } = this.executeSync();
    return { results, success: true, meta };
  }

  /** Used by `first`/`all`/`run` and, synchronously, by `batch`. */
  executeSync(): { results: Row[]; meta: Record<string, number> } {
    const statement = this.db.prepare(this.sql);
    const params = this.params as Bindable[];

    if (producesRows(this.sql)) {
      const results = statement.all(...params) as Row[];
      return { results, meta: { changes: this.changes(), last_row_id: 0, duration: 0 } };
    }

    const info = statement.run(...params);
    return {
      results: [],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        duration: 0,
      },
    };
  }

  /** `changes()` reports the rows the most recent statement modified. */
  private changes(): number {
    const row = this.db.prepare('SELECT changes() AS c').get() as { c: number } | undefined;
    return Number(row?.c ?? 0);
  }
}

/** An in-memory database with the real schema applied. */
export function createTestDb(): D1Database & { close(): void } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  const api = {
    prepare(sql: string) {
      return new FakeStatement(sqlite, sql) as unknown as D1PreparedStatement;
    },
    async batch<T = Row>(statements: D1PreparedStatement[]) {
      // D1 runs a batch as one transaction; so does this, which is what the
      // resumability invariant is actually relying on.
      sqlite.exec('BEGIN');
      try {
        const out = statements.map((s) => (s as unknown as FakeStatement).executeSync());
        sqlite.exec('COMMIT');
        return out.map((r) => ({ results: r.results as T[], success: true as const, meta: r.meta }));
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      throw new Error('dump() is not implemented in the test adapter');
    },
    withSession() {
      throw new Error('withSession() is not implemented in the test adapter');
    },
    close() {
      sqlite.close();
    },
  };

  return api as unknown as D1Database & { close(): void };
}

/** A KVNamespace backed by a Map — enough for the item→category cache. */
export function createTestKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
    store,
  };
  return kv as unknown as KVNamespace & { store: Map<string, string> };
}

/** Seeds the single carrier the sync is written against. */
export async function seedCarrier(
  db: D1Database,
  createdAt: number,
  cardNo = '/TEST123',
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO carrier (id, card_type, card_no, label, created_at) VALUES (1, ?, ?, ?, ?)`,
    )
    .bind('3J0002', cardNo, 'test', createdAt)
    .run();
}
