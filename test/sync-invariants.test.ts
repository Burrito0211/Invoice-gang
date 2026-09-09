/**
 * The five invariants from docs/SYNC.md, asserted directly.
 *
 * These tests are the actual deliverable of the sync module. The first one is
 * the late-arriving-invoice case: it is why the overlap re-scan exists, and it
 * is the reason the rest of the design looks the way it does, so it is written
 * first and should be the last thing anyone deletes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSync } from '../src/sync/run.js';
import { isoToUnix } from '../src/lib/dates.js';
import { createTestDb, createTestKv, seedCarrier } from './helpers/d1.js';
import { FakeEInvoiceApi, header, item } from './helpers/fake-api.js';
import type { RunSyncDeps, RunSyncOptions } from '../src/sync/run.js';

const CARD_NO = '/TEST123';
const CARRIER_SINCE = '2026-08-01';

let db: ReturnType<typeof createTestDb>;
let kv: ReturnType<typeof createTestKv>;

beforeEach(() => {
  db = createTestDb();
  kv = createTestKv();
});

afterEach(() => {
  db.close();
});

/** A clock the test moves by hand — `runSync` never reads the real one. */
function clockAt(date: string): () => number {
  let t = isoToUnix(date) + 12 * 3600;
  return () => (t += 1);
}

function deps(api: FakeEInvoiceApi, now: () => number): RunSyncDeps {
  // llm: null — the cascade's steps 1–4 are pure, and no test calls a model.
  return { api, db, kv, now, llm: null };
}

function options(overrides: Partial<RunSyncOptions> = {}): RunSyncOptions {
  return {
    trigger: 'manual',
    cardNo: CARD_NO,
    overlapDays: 7,
    windowDays: 30,
    headerCallBudget: 6,
    detailBudget: 200,
    ...overrides,
  };
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('the late-arriving invoice', () => {
  it('is picked up on the next run when it lands inside the overlap window', async () => {
    // This is the test that justifies the whole design. A merchant files an
    // invoice days after the purchase; its date is already behind the
    // watermark by the time it appears. Without the overlap re-scan it would
    // be skipped permanently and silently.
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);

    const onTime = header({ invDate: '2026-09-02', invNum: 'AA10000001' });
    const api = new FakeEInvoiceApi({ headers: [onTime], details: { AA10000001: [item()] } });

    await runSync(deps(api, clockAt('2026-09-05')), options());
    expect(await count('invoice')).toBe(1);

    const watermark = await db
      .prepare(`SELECT synced_through FROM sync_state WHERE carrier_id = 1`)
      .first<{ synced_through: string }>();
    expect(watermark?.synced_through).toBe('2026-09-05');

    // Filed on the 8th, dated the 3rd — behind a watermark of the 5th.
    const late = header({ invDate: '2026-09-03', invNum: 'AA10000002', amount: 240 });
    api.fileLate(late, [item({ description: '御飯糰 鮪魚' })]);

    const callsBefore = api.headerCalls.length;
    await runSync(deps(api, clockAt('2026-09-08')), options());

    const found = await db
      .prepare(`SELECT inv_num, amount FROM invoice WHERE inv_num = 'AA10000002'`)
      .first<{ inv_num: string; amount: number }>();
    expect(found).not.toBeNull();
    expect(found?.amount).toBe(240);

    // And its items were fetched, not just its header.
    expect(await count('invoice_item')).toBe(2);

    // The second run's first window really did start before the watermark.
    const secondRunWindow = api.headerCalls[callsBefore];
    expect(secondRunWindow?.start).toBe('2026-08-29'); // 2026-09-05 minus 7
  });
});

describe('invariant 1 — idempotent', () => {
  it('produces no duplicate invoices or items when run twice back to back', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const api = new FakeEInvoiceApi({
      headers: [header({ invDate: '2026-09-01', invNum: 'AA20000001' })],
      details: {
        AA20000001: [item({ rowNum: 1 }), item({ rowNum: 2, description: '茶葉蛋' })],
      },
    });

    await runSync(deps(api, clockAt('2026-09-05')), options());
    const afterFirst = { invoices: await count('invoice'), items: await count('invoice_item') };

    await runSync(deps(api, clockAt('2026-09-05')), options());
    const afterSecond = { invoices: await count('invoice'), items: await count('invoice_item') };

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond).toEqual({ invoices: 1, items: 2 });
  });

  it('does not re-fetch details for invoices already fetched', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const api = new FakeEInvoiceApi({
      headers: [header({ invDate: '2026-09-01', invNum: 'AA30000001' })],
      details: { AA30000001: [item()] },
    });

    await runSync(deps(api, clockAt('2026-09-05')), options());
    expect(api.detailCalls).toEqual(['AA30000001']);

    await runSync(deps(api, clockAt('2026-09-06')), options());
    // Still one: the overlap re-scan re-read the header but the upsert left
    // detail_fetched_at alone, so it never went back on the queue.
    expect(api.detailCalls).toEqual(['AA30000001']);
  });
});

describe('invariant 2 — resumable', () => {
  it('does not advance the watermark past headers that were never committed', async () => {
    await seedCarrier(db, isoToUnix('2026-06-01'), CARD_NO);
    // Quota on the second header call: the first window commits, the second
    // never happens, and the watermark must reflect exactly that.
    const api = new FakeEInvoiceApi({
      headers: [header({ invDate: '2026-06-10', invNum: 'AA40000001' })],
      quotaOnHeaderCall: 2,
    });

    const run = await runSync(deps(api, clockAt('2026-09-05')), options());

    expect(run.status).toBe('quota');
    const state = await db
      .prepare(`SELECT synced_through FROM sync_state WHERE carrier_id = 1`)
      .first<{ synced_through: string }>();
    // First window was 2026-05-25 → 2026-06-24 and committed; nothing beyond.
    expect(state?.synced_through).toBe('2026-06-24');
    expect(await count('invoice')).toBe(1);
  });

  it('resumes from the committed watermark on the following run', async () => {
    await seedCarrier(db, isoToUnix('2026-06-01'), CARD_NO);
    const api = new FakeEInvoiceApi({
      headers: [
        header({ invDate: '2026-06-10', invNum: 'AA50000001' }),
        header({ invDate: '2026-07-10', invNum: 'AA50000002' }),
      ],
      quotaOnHeaderCall: 2,
    });

    await runSync(deps(api, clockAt('2026-09-05')), options());
    expect(await count('invoice')).toBe(1);

    // A fresh client with no quota fault: the run continues where it stopped.
    const healthy = new FakeEInvoiceApi({
      headers: [
        header({ invDate: '2026-06-10', invNum: 'AA50000001' }),
        header({ invDate: '2026-07-10', invNum: 'AA50000002' }),
      ],
    });
    await runSync(deps(healthy, clockAt('2026-09-06')), options());

    expect(await count('invoice')).toBe(2);
    expect(healthy.headerCalls[0]?.start).toBe('2026-06-17'); // 2026-06-24 minus 7
  });
});

describe('invariant 3 — monotone', () => {
  it('updates status and amount but never deletes an invoice or its items', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const original = header({ invDate: '2026-09-01', invNum: 'AA60000001', amount: 500 });
    const api = new FakeEInvoiceApi({
      headers: [original],
      details: { AA60000001: [item({ amount: 500 })] },
    });

    await runSync(deps(api, clockAt('2026-09-05')), options());
    const before = await db
      .prepare(`SELECT first_seen_at, detail_fetched_at FROM invoice WHERE inv_num = 'AA60000001'`)
      .first<{ first_seen_at: number; detail_fetched_at: number }>();

    // The invoice is voided and re-reported by the API.
    original.invStatus = '作廢';
    original.amount = 0;
    await runSync(deps(api, clockAt('2026-09-06')), options());

    const after = await db
      .prepare(
        `SELECT inv_status, amount, first_seen_at, detail_fetched_at
         FROM invoice WHERE inv_num = 'AA60000001'`,
      )
      .first<{
        inv_status: string;
        amount: number;
        first_seen_at: number;
        detail_fetched_at: number;
      }>();

    expect(after?.inv_status).toBe('作廢');
    expect(after?.amount).toBe(0);
    // The two fields the upsert must never touch.
    expect(after?.first_seen_at).toBe(before?.first_seen_at);
    expect(after?.detail_fetched_at).toBe(before?.detail_fetched_at);
    // Items are only ever added.
    expect(await count('invoice_item')).toBe(1);
  });
});

describe('invariant 4 — bounded', () => {
  it('makes at most DETAIL_BUDGET_PER_RUN detail calls however far behind it is', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const headers = Array.from({ length: 25 }, (_, i) =>
      header({ invDate: '2026-09-01', invNum: `AA7${String(1_000_000 + i)}` }),
    );
    const details = Object.fromEntries(headers.map((h) => [h.invNum, [item()]]));
    const api = new FakeEInvoiceApi({ headers, details });

    await runSync(deps(api, clockAt('2026-09-05')), options({ detailBudget: 10 }));

    expect(api.detailCalls).toHaveLength(10);
    expect(await count('invoice')).toBe(25);
    expect(await count('invoice_item')).toBe(10);
  });

  it('makes at most headerCallBudget header calls on a long backfill', async () => {
    // Two years behind, 30-day windows: unbounded this would be ~25 calls.
    await seedCarrier(db, isoToUnix('2024-09-01'), CARD_NO);
    const api = new FakeEInvoiceApi({ headers: [] });

    await runSync(deps(api, clockAt('2026-09-05')), options({ headerCallBudget: 4 }));

    expect(api.headerCalls).toHaveLength(4);
  });

  it('drains the newest invoices first', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const api = new FakeEInvoiceApi({
      headers: [
        header({ invDate: '2026-08-10', invNum: 'AA80000001' }),
        header({ invDate: '2026-09-02', invNum: 'AA80000002' }),
        header({ invDate: '2026-08-20', invNum: 'AA80000003' }),
      ],
    });

    await runSync(deps(api, clockAt('2026-09-05')), options({ detailBudget: 2 }));

    expect(api.detailCalls).toEqual(['AA80000002', 'AA80000003']);
  });
});

describe('invariant 5 — quota-safe', () => {
  it('ends with status quota and keeps everything already committed', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const headers = [
      header({ invDate: '2026-09-03', invNum: 'AA90000001' }),
      header({ invDate: '2026-09-02', invNum: 'AA90000002' }),
      header({ invDate: '2026-09-01', invNum: 'AA90000003' }),
    ];
    const api = new FakeEInvoiceApi({
      headers,
      details: Object.fromEntries(headers.map((h) => [h.invNum, [item()]])),
      quotaOnDetailCall: 3,
    });

    const run = await runSync(deps(api, clockAt('2026-09-05')), options());

    expect(run.status).toBe('quota');
    expect(run.error).toBeNull(); // a quota stop is a normal outcome, not an error
    // The two invoices fetched before the quota hit are committed with items.
    expect(await count('invoice_item')).toBe(2);
    expect(run.details_fetched).toBe(2);

    // The third is still queued, and its attempt counter was not bumped —
    // it was never actually tried against a working API.
    const pending = await db
      .prepare(
        `SELECT inv_num, detail_attempts FROM invoice WHERE detail_fetched_at IS NULL`,
      )
      .all<{ inv_num: string; detail_attempts: number }>();
    expect(pending.results.map((r) => r.inv_num)).toEqual(['AA90000003']);
  });

  it('picks up where it left off on the next run', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const headers = [
      header({ invDate: '2026-09-03', invNum: 'AB10000001' }),
      header({ invDate: '2026-09-02', invNum: 'AB10000002' }),
    ];
    const details = Object.fromEntries(headers.map((h) => [h.invNum, [item()]]));

    const throttled = new FakeEInvoiceApi({ headers, details, quotaOnDetailCall: 2 });
    await runSync(deps(throttled, clockAt('2026-09-05')), options());
    expect(await count('invoice_item')).toBe(1);

    const tomorrow = new FakeEInvoiceApi({ headers, details });
    const run = await runSync(deps(tomorrow, clockAt('2026-09-06')), options());

    expect(run.status).toBe('ok');
    expect(await count('invoice_item')).toBe(2);
    expect(tomorrow.detailCalls).toEqual(['AB10000002']);
  });
});

describe('the detail queue', () => {
  it('does not mark an invoice fetched when the detail response is empty', async () => {
    // Details can lag behind headers. Marking an empty response complete
    // would make the miss permanent.
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const api = new FakeEInvoiceApi({
      headers: [header({ invDate: '2026-09-01', invNum: 'AB20000001' })],
      details: {},
    });

    await runSync(deps(api, clockAt('2026-09-05')), options());

    const row = await db
      .prepare(
        `SELECT detail_fetched_at, detail_attempts, detail_error
         FROM invoice WHERE inv_num = 'AB20000001'`,
      )
      .first<{ detail_fetched_at: number | null; detail_attempts: number; detail_error: string }>();

    expect(row?.detail_fetched_at).toBeNull();
    expect(row?.detail_attempts).toBe(1);
    expect(row?.detail_error).toMatch(/no rows/);

    // And the items arrive on a later run, once the merchant filed them.
    api.addDetails('AB20000001', [item()]);
    await runSync(deps(api, clockAt('2026-09-06')), options());
    expect(await count('invoice_item')).toBe(1);
  });

  it('gives up after five attempts so one invoice cannot wedge the queue', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const api = new FakeEInvoiceApi({
      headers: [header({ invDate: '2026-09-01', invNum: 'AB30000001' })],
      details: {},
    });

    for (let day = 5; day <= 12; day++) {
      await runSync(deps(api, clockAt(`2026-09-${String(day).padStart(2, '0')}`)), options());
    }

    const row = await db
      .prepare(`SELECT detail_attempts FROM invoice WHERE inv_num = 'AB30000001'`)
      .first<{ detail_attempts: number }>();
    expect(row?.detail_attempts).toBe(5);
    expect(api.detailCalls).toHaveLength(5);
  });

  it('lets one failing invoice fail without aborting the run', async () => {
    await seedCarrier(db, isoToUnix(CARRIER_SINCE), CARD_NO);
    const headers = [
      header({ invDate: '2026-09-03', invNum: 'AB40000001' }),
      header({ invDate: '2026-09-02', invNum: 'AB40000002' }),
    ];
    const api = new FakeEInvoiceApi({
      headers,
      details: Object.fromEntries(headers.map((h) => [h.invNum, [item()]])),
      failingInvoices: new Set(['AB40000001']),
    });

    const run = await runSync(deps(api, clockAt('2026-09-05')), options());

    expect(run.status).toBe('partial');
    expect(api.detailCalls).toHaveLength(2); // it moved on to the next invoice
    expect(await count('invoice_item')).toBe(1);
  });
});
