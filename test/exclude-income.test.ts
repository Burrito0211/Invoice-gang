/**
 * Item exclusion and manual income.
 *
 * Excluding an item must remove it from every spend total but leave it on its
 * invoice, and income must sit entirely beside the invoice pipeline. Both are
 * checked against the same fixture the importer uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importCarrierCsv } from '../src/import/run.js';
import {
  deleteIncome,
  incomeTotalForRange,
  insertIncome,
  listIncome,
  setItemExcluded,
  summaryByCategory,
  totalsForRange,
} from '../src/db/queries.js';
import { createTestDb, createTestKv, seedAccount } from './helpers/d1.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(join(here, 'fixtures', 'carrier-export.csv'), 'utf8');
const FROM = '2026-09-01';
const TO = '2026-09-30';

let db: ReturnType<typeof createTestDb>;
let kv: ReturnType<typeof createTestKv>;

beforeEach(async () => {
  db = createTestDb();
  kv = createTestKv();
  // Load the rule table so items are actually categorized — otherwise the
  // category-breakdown assertion would pass trivially, everything being
  // uncategorized.
  await db.exec(readFileSync(join(here, '..', 'src', 'db', 'rules-tw.sql'), 'utf8'));
  let t = 1_780_000_000;
  await seedAccount(db, 1_750_000_000);
  await importCarrierCsv(CSV, { db, kv, now: () => (t += 1), llm: null }, {
    accountId: 1,
    carrierId: 1,
    trigger: 'manual',
  });
});

afterEach(() => db.close());

const spent = async () => (await totalsForRange(db, 1, FROM, TO))!.invoice_total;

describe('excluding an item', () => {
  it('drops its amount from the total but leaves it on the invoice', async () => {
    const before = await spent();
    const item = await db
      .prepare(`SELECT id, COALESCE(net_amount, amount) AS net FROM invoice_item WHERE amount >= 0 LIMIT 1`)
      .first<{ id: number; net: number }>();

    const changed = await setItemExcluded(db, 1,item!.id, true);
    expect(changed).toBe(true);
    expect(await spent()).toBe(before - item!.net);

    // Still physically present — the invoice must reconcile against paper.
    const stillThere = await db
      .prepare(`SELECT excluded FROM invoice_item WHERE id = ?`)
      .bind(item!.id)
      .first<{ excluded: number }>();
    expect(stillThere?.excluded).toBe(1);
  });

  it('drops out of the category breakdown as well as the total', async () => {
    // The fixture's one health item is 口罩50入 on the masked invoice.
    const item = await db
      .prepare(`SELECT id FROM invoice_item WHERE description LIKE '%口罩%' LIMIT 1`)
      .first<{ id: number }>();
    expect(item).not.toBeNull();
    await setItemExcluded(db, 1,item!.id, true);

    const rows = (await summaryByCategory(db, 1, FROM, TO)) as { key: string; total: number }[];
    // Excluding the only health item removes the category from the breakdown.
    expect(rows.find((r) => r.key === 'health')).toBeUndefined();
  });

  it('re-including restores the amount exactly', async () => {
    const before = await spent();
    const item = await db.prepare(`SELECT id FROM invoice_item WHERE amount >= 0 LIMIT 1`).first<{ id: number }>();
    await setItemExcluded(db, 1,item!.id, true);
    await setItemExcluded(db, 1,item!.id, false);
    expect(await spent()).toBe(before);
  });

  it('reports no change for an id that does not exist', async () => {
    expect(await setItemExcluded(db, 1,999999, true)).toBe(false);
  });
});

describe('income', () => {
  it('is summed over the range and lives apart from spending', async () => {
    const spentBefore = await spent();
    await insertIncome(db, 1, { date: '2026-09-15', amount: 45000, source: '薪資', note: null, now: 1 });
    await insertIncome(db, 1, { date: '2026-09-20', amount: 3000, source: '接案', note: 'a job', now: 2 });

    expect(await incomeTotalForRange(db, 1, FROM, TO)).toBe(48000);
    // Income must not have touched the spending total.
    expect(await spent()).toBe(spentBefore);
  });

  it('respects the date range', async () => {
    await insertIncome(db, 1, { date: '2026-08-31', amount: 999, source: 'x', note: null, now: 1 });
    expect(await incomeTotalForRange(db, 1, FROM, TO)).toBe(0);
  });

  it('lists and deletes', async () => {
    const id = await insertIncome(db, 1, { date: '2026-09-10', amount: 100, source: 's', note: null, now: 1 });
    expect((await listIncome(db, 1, FROM, TO)).length).toBe(1);
    expect(await deleteIncome(db, 1, id)).toBe(true);
    expect((await listIncome(db, 1, FROM, TO)).length).toBe(0);
  });
});
