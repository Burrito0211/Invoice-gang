/**
 * The CSV importer.
 *
 * The fixture mirrors a real export's structure exactly — 14 columns in the
 * verified order, the two prose footer lines, a negative discount line, an
 * invoice with two identical lines, and a masked invoice number — with
 * synthetic contents, so the real file (personal purchase history) never
 * enters the repository.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CsvFormatError, parseCarrierCsv, parseCsvLine } from '../src/import/csv.js';
import { importCarrierCsv } from '../src/import/run.js';
import { handleImportStatus } from '../src/api/status.js';
import { selectUncategorizedItems } from '../src/db/queries.js';
import { fromApiDate } from '../src/lib/dates.js';
import { createTestDb, createTestKv, seedCarrier } from './helpers/d1.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(join(here, 'fixtures', 'carrier-export.csv'), 'utf8');

let db: ReturnType<typeof createTestDb>;
let kv: ReturnType<typeof createTestKv>;
let clock: () => number;

beforeEach(async () => {
  db = createTestDb();
  kv = createTestKv();
  // One clock per test, shared by every import in it. Newness is inferred
  // from `first_seen_at == now`, so a clock that restarted between imports
  // would make an existing row look new — which no real clock does.
  let t = 1_780_000_000;
  clock = () => (t += 1);
  await seedCarrier(db, 1_750_000_000);
});

afterEach(() => db.close());

const deps = () => ({ db, kv, now: clock, llm: null });
const options = { carrierId: 1, trigger: 'manual' as const };

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('date parsing', () => {
  it('accepts the packed YYYYMMDD form the export uses', () => {
    // This form returned null before the export was inspected — the parser
    // handled the ROC packed form but not this one.
    expect(fromApiDate('20260904')).toBe('2026-09-04');
  });
});

describe('parseCsvLine', () => {
  it('keeps a comma that appears inside a quoted product name', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes a doubled quote', () => {
    expect(parseCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });
});

describe('parseCarrierCsv', () => {
  it('groups the flattened rows back into invoices', () => {
    const { invoices } = parseCarrierCsv(CSV);
    expect(invoices).toHaveLength(4);
    expect(invoices.map((i) => i.header.invNum)).toEqual([
      'EX31020263',
      'EY44910873',
      'ES35915268',
      'EZ1234**',
    ]);
  });

  it('sums the line amounts for the invoice total', () => {
    // 發票金額 carries the *line* amount, not the invoice total. Trusting the
    // column would have stored -15 for this invoice.
    const invoice = parseCarrierCsv(CSV).invoices[0]!;
    expect(invoice.items.map((i) => i.amount)).toEqual([35, 35, 28, -15]);
    expect(invoice.header.amount).toBe(83);
  });

  it('keeps negative discount lines, which is what makes the total add up', () => {
    const invoice = parseCarrierCsv(CSV).invoices[1]!;
    expect(invoice.items[1]).toMatchObject({ amount: -10, description: '折扣（10％）' });
    expect(invoice.header.amount).toBe(49);
  });

  it('numbers rows by position so identical lines both survive', () => {
    // This invoice has two lines identical in name, quantity and amount. Any
    // content-derived key would silently merge them into one purchase.
    const invoice = parseCarrierCsv(CSV).invoices[2]!;
    expect(invoice.items).toHaveLength(2);
    expect(invoice.items.map((i) => i.rowNum)).toEqual([1, 2]);
    expect(invoice.header.amount).toBe(80);
  });

  it('converts the packed date and derives nothing it was not given', () => {
    const invoice = parseCarrierCsv(CSV).invoices[0]!;
    expect(invoice.header.invDate).toBe('2026-09-04');
    expect(invoice.header.sellerBan).toBe('16631427');
    expect(invoice.header.invPeriod).toBeNull(); // not in the export
  });

  it('flags a masked invoice number instead of trusting it as a key', () => {
    const invoice = parseCarrierCsv(CSV).invoices[3]!;
    expect(invoice.masked).toBe(true);
    expect(invoice.header.invStatus).toContain('號碼隱碼');
  });

  it('ignores the prose footer lines', () => {
    const { invoices, skipped } = parseCarrierCsv(CSV);
    expect(skipped).toHaveLength(0);
    expect(invoices.every((i) => i.header.invNum !== '')).toBe(true);
  });

  it('refuses a file whose columns moved rather than mis-reading it', () => {
    const scrambled = CSV.replace('發票日期,發票號碼', '發票號碼,發票日期');
    expect(() => parseCarrierCsv(scrambled)).toThrow(CsvFormatError);
  });

  it('refuses a file that is not an invoice export at all', () => {
    expect(() => parseCarrierCsv('a,b,c\n1,2,3')).toThrow(CsvFormatError);
  });

  it('tolerates a BOM, since the export ships with one', () => {
    expect(parseCarrierCsv(`﻿${CSV}`).invoices).toHaveLength(4);
  });
});

describe('importing', () => {
  it('writes invoices and items, and records the run', async () => {
    const result = await importCarrierCsv(CSV, deps(), options);

    expect(result.run.status).toBe('ok');
    expect(await count('invoice')).toBe(4);
    expect(await count('invoice_item')).toBe(9);
    expect(result.run.headers_new).toBe(4);
    expect(result.run.items_new).toBe(9);
    expect(result.masked).toEqual(['EZ1234**']);
  });

  it('stores the summed total, not the column', async () => {
    await importCarrierCsv(CSV, deps(), options);
    const row = await db
      .prepare(`SELECT amount FROM invoice WHERE inv_num = 'EX31020263'`)
      .first<{ amount: number }>();
    expect(row?.amount).toBe(83);
  });

  it('is idempotent — re-importing the same export changes nothing', async () => {
    // Exports overlap by design: you download the last few months every time.
    await importCarrierCsv(CSV, deps(), options);
    const before = { inv: await count('invoice'), items: await count('invoice_item') };

    const second = await importCarrierCsv(CSV, deps(), options);

    expect({ inv: await count('invoice'), items: await count('invoice_item') }).toEqual(before);
    expect(second.run.headers_new).toBe(0);
    expect(second.run.items_new).toBe(0);
  });

  it('is monotone — a later export never removes what an earlier one added', async () => {
    await importCarrierCsv(CSV, deps(), options);

    // A later export covering only the most recent day.
    const lines = CSV.split('\n');
    const partial = [lines[0], ...lines.slice(1, 5)].join('\n');
    await importCarrierCsv(partial, deps(), options);

    expect(await count('invoice')).toBe(4);
    expect(await count('invoice_item')).toBe(9);
  });

  it('adds invoices that only appear in a later export', async () => {
    const lines = CSV.split('\n');
    const firstExport = [lines[0], ...lines.slice(1, 5)].join('\n');
    await importCarrierCsv(firstExport, deps(), options);
    expect(await count('invoice')).toBe(1);

    await importCarrierCsv(CSV, deps(), options);
    expect(await count('invoice')).toBe(4);
    expect(await count('invoice_item')).toBe(9);
  });

  it('advances the watermark to the last date in the export', async () => {
    await importCarrierCsv(CSV, deps(), options);
    const state = await db
      .prepare(`SELECT synced_through FROM sync_state WHERE carrier_id = 1`)
      .first<{ synced_through: string }>();
    expect(state?.synced_through).toBe('2026-09-04');
  });

  it('leaves nothing sitting in the old detail queue', async () => {
    // Items arrive with the header in a CSV, so there is nothing to fetch.
    await importCarrierCsv(CSV, deps(), options);
    const pending = await db
      .prepare(`SELECT COUNT(*) AS n FROM invoice WHERE detail_fetched_at IS NULL`)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it('records a parse failure on the run instead of throwing', async () => {
    const result = await importCarrierCsv('not,a,csv', deps(), options);
    expect(result.run.status).toBe('error');
    expect(result.run.error).toMatch(/missing column/);
  });
});

describe('import status', () => {
  it('never reports a negative age for an import that just ran', async () => {
    // The first version derived "now" from midnight UTC of today's date, so an
    // import an hour old was younger than the reference point and aged to -1.
    await importCarrierCsv(CSV, deps(), options);

    const response = await handleImportStatus(db, 1, clock(), 10);
    const body = (await response.json()) as {
      age_days: number | null;
      stale: boolean;
      covered_through: string | null;
    };

    expect(body.age_days).toBe(0);
    expect(body.stale).toBe(false);
    expect(body.covered_through).toBe('2026-09-04');
  });

  it('reports stale when nothing has ever been imported', async () => {
    const response = await handleImportStatus(db, 1, clock(), 10);
    const body = (await response.json()) as { age_days: number | null; stale: boolean };

    expect(body.age_days).toBeNull();
    expect(body.stale).toBe(true);
  });
});

describe('discount allocation through an import', () => {
  const netOf = async (invNum: string) => {
    const { results } = await db
      .prepare(
        `SELECT row_num, description, amount, net_amount FROM invoice_item
         WHERE inv_num = ? ORDER BY row_num`,
      )
      .bind(invNum)
      .all<{ row_num: number; description: string; amount: number; net_amount: number }>();
    return results;
  };

  it('spreads an invoice discount across its positive lines', async () => {
    await importCarrierCsv(CSV, deps(), options);

    // EY44910873: 59 + a -10 discount.
    const rows = await netOf('EY44910873');
    expect(rows.map((r) => r.net_amount)).toEqual([49, 0]);
    expect(rows.reduce((s, r) => s + r.net_amount, 0)).toBe(49);
  });

  it('nets to the invoice total, matching the stored header amount', async () => {
    await importCarrierCsv(CSV, deps(), options);

    for (const invNum of ['EX31020263', 'EY44910873', 'ES35915268', 'EZ1234**']) {
      const rows = await netOf(invNum);
      const header = await db
        .prepare(`SELECT amount FROM invoice WHERE inv_num = ?`)
        .bind(invNum)
        .first<{ amount: number }>();
      expect(rows.reduce((s, r) => s + r.net_amount, 0)).toBe(header?.amount);
    }
  });

  it('recomputes the allocation on re-import instead of leaving it stale', async () => {
    // INSERT OR IGNORE does not update, so without an explicit refresh a
    // re-import would keep whatever the first one wrote.
    await importCarrierCsv(CSV, deps(), options);
    await db.prepare(`UPDATE invoice_item SET net_amount = 999`).run();

    await importCarrierCsv(CSV, deps(), options);

    const rows = await netOf('EY44910873');
    expect(rows.map((r) => r.net_amount)).toEqual([49, 0]);
  });

  it('keeps discount rows out of the classifier queue', async () => {
    // Classifying "折扣（10％）" would spend a model call on an accounting
    // adjustment and file it under some spending category.
    await importCarrierCsv(CSV, deps(), options);

    const queued = await selectUncategorizedItems(db, 100);
    expect(queued.some((r) => r.description.includes('折扣'))).toBe(false);
    expect(queued.length).toBeGreaterThan(0);
  });
});
