/**
 * Migration 005, run against a database in the shape it will actually meet:
 * the pre-accounts schema, holding data, with columns in the order a deployed
 * database has them.
 *
 * The migration rebuilds every personal table, and each way that can go wrong
 * is silent — a cascade that empties the items table, a column copied into the
 * wrong slot, a foreign key left pointing at a dropped table, a table that
 * ends up subtly different from what schema.sql creates for a fresh install.
 * So each is checked directly rather than trusted to the SQL reading right.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importCarrierCsv } from '../src/import/run.js';
import { createTestDb, createTestKv } from './helpers/d1.js';

const here = dirname(fileURLToPath(import.meta.url));
const BEFORE = readFileSync(join(here, 'fixtures', 'schema-before-005.sql'), 'utf8');
const MIGRATION = readFileSync(
  join(here, '..', 'src', 'db', 'migrations', '005-accounts.sql'),
  'utf8',
);
const CSV = readFileSync(join(here, 'fixtures', 'carrier-export.csv'), 'utf8');

const TABLES = [
  'carrier',
  'invoice',
  'invoice_item',
  'prize_hit',
  'sync_state',
  'sync_run',
  'user_override',
  'income',
  'budget',
  'item_category_cache',
];

let db: ReturnType<typeof createTestDb>;
let before: Record<string, number>;

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    out[table] = row?.n ?? 0;
  }
  return out;
}

beforeEach(async () => {
  db = createTestDb(BEFORE);
  await db.exec(`
    INSERT INTO carrier (id, card_type, card_no, label, created_at)
      VALUES (1, '3J0002', 'default', 'owner', 1750000000);
    INSERT INTO invoice (inv_num, carrier_id, inv_date, inv_period, seller_ban, seller_name, amount,
                         inv_status, donatable, detail_fetched_at, first_seen_at, updated_at)
      VALUES ('EX31020263', 1, '2026-09-04', '11510', '16631427', '統一超商', 83, '開立已確認', 0,
              1780000001, 1780000001, 1780000001),
             ('AB12345678', 1, '2026-09-05', '11510', NULL, '麵店', 120, NULL, 0,
              1780000002, 1780000002, 1780000002);
    INSERT INTO invoice_item (id, inv_num, row_num, description, item_key, quantity, unit_price, amount,
                              category_id, category_source, categorized_at, net_amount, excluded)
      VALUES (10, 'EX31020263', 1, '拿鐵', '拿鐵', 1, 35, 35, 3, 'merchant', 1780000001, 29, 1),
             (11, 'EX31020263', 2, '折扣', '折扣', 1, -15, -15, NULL, NULL, NULL, 0, 0),
             (12, 'AB12345678', 1, '牛肉麵', '牛肉麵', 1, 120, 120, 2, 'override', 1780000002, 120, 0);
    INSERT INTO prize_hit (inv_num, inv_period, prize_class, amount, matched_at, notified_at)
      VALUES ('AB12345678', '11510', 'additional', 200, 1780000003, NULL);
    INSERT INTO user_override (id, scope, key, category_id, created_at)
      VALUES (5, 'item', '牛肉麵', 2, 1780000002);
    INSERT INTO sync_state (carrier_id, synced_through, last_run_at, last_success_at)
      VALUES (1, '2026-09-05', 1780000004, 1780000004);
    INSERT INTO sync_run (id, started_at, finished_at, trigger, status, headers_seen, headers_new, items_new)
      VALUES (7, 1780000000, 1780000004, 'manual', 'ok', 2, 2, 3);
    INSERT INTO income (id, date, amount, source, note, created_at)
      VALUES (3, '2026-09-10', 45000, '薪資', NULL, 1780000005);
    INSERT INTO budget (month, amount, created_at, updated_at)
      VALUES ('2026-09', 20000, 1780000006, 1780000006);
    INSERT INTO item_category_cache (item_key, category_id, confidence, model, sample_desc, created_at, hits)
      VALUES ('拿鐵', 3, 0.9, 'test', '拿鐵', 1, 4);
  `);
  before = await counts();
  await db.exec(MIGRATION);
});

afterEach(() => db.close());

describe('migration 005', () => {
  it('turns the existing install into account 1, `owner`, with no password yet', async () => {
    const account = await db
      .prepare(`SELECT id, username, password_hash, created_at FROM account`)
      .all<{ id: number; username: string; password_hash: string | null; created_at: number }>();
    expect(account.results).toEqual([
      { id: 1, username: 'owner', password_hash: null, created_at: 1750000000 },
    ]);
  });

  it('keeps every row, and hands every personal row to account 1', async () => {
    expect(await counts()).toEqual(before);
    for (const table of ['carrier', 'invoice', 'invoice_item', 'prize_hit', 'sync_run', 'user_override', 'income', 'budget']) {
      const stray = await db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id IS NOT 1`)
        .first<{ n: number }>();
      expect(stray?.n, `${table} has rows outside account 1`).toBe(0);
    }
  });

  it('keeps item ids, which nothing else is allowed to renumber', async () => {
    const ids = await db.prepare(`SELECT id FROM invoice_item ORDER BY id`).all<{ id: number }>();
    expect(ids.results.map((r) => r.id)).toEqual([10, 11, 12]);
  });

  it('copies columns by name, not by position', async () => {
    // net_amount and excluded sit last in the old table and mid-table in the
    // new one; a positional copy would put 29 in `excluded`.
    const item = await db
      .prepare(`SELECT net_amount, excluded, category_id, category_source FROM invoice_item WHERE id = 10`)
      .first();
    expect(item).toEqual({ net_amount: 29, excluded: 1, category_id: 3, category_source: 'merchant' });
  });

  it('leaves no foreign key dangling', async () => {
    const violations = await db.prepare(`PRAGMA foreign_key_check`).all();
    expect(violations.results).toEqual([]);
  });

  it('ends with exactly the tables, keys and indexes a fresh install gets', async () => {
    const fresh = createTestDb();
    try {
      expect(await shape(db)).toEqual(await shape(fresh));
    } finally {
      fresh.close();
    }
  });

  it('can import into the migrated account without duplicating what was there', async () => {
    const kv = createTestKv();
    let t = 1_790_000_000;
    const result = await importCarrierCsv(
      CSV,
      { db, kv, now: () => (t += 1), llm: null },
      { accountId: 1, carrierId: 1, trigger: 'manual' },
    );
    expect(result.run.status).toBe('ok');
    // EX31020263 was already there; the fixture's other three are new.
    expect(result.run.headers_new).toBe(3);
    const invoices = await db.prepare(`SELECT COUNT(*) AS n FROM invoice`).first<{ n: number }>();
    expect(invoices?.n).toBe(5);
  });
});

/** Tables and views with their columns, foreign keys and indexes — everything but formatting. */
async function shape(target: D1Database) {
  const objects = await target
    .prepare(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all<{ name: string; type: string }>();

  const out: Record<string, unknown> = {};
  for (const { name, type } of objects.results) {
    const columns = await target
      .prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`)
      .bind(name)
      .all();
    const foreignKeys = await target
      .prepare(
        `SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?) ORDER BY "table", "from"`,
      )
      .bind(name)
      .all();
    const indexes = await target
      .prepare(`SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name`)
      .bind(name)
      .all();
    out[name] = {
      type,
      columns: columns.results,
      foreignKeys: foreignKeys.results,
      indexes: indexes.results,
    };
  }
  return out;
}
