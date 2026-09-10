/**
 * The cascade: order of precedence, and the correction loop.
 *
 * Steps 1–4 are pure and never touch the network, so all of this runs with
 * `llm: null` — reaching a model at all would mean the free steps failed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categorizeItems } from '../src/categorize/pipeline.js';
import { matchRule, resolve } from '../src/categorize/rules.js';
import {
  applyOverrideToItems,
  insertMerchantRule,
  listCategories,
  upsertCacheStatement,
  upsertOverride,
} from '../src/db/queries.js';
import { createTestDb, createTestKv, seedCarrier } from './helpers/d1.js';

let db: ReturnType<typeof createTestDb>;
let kv: ReturnType<typeof createTestKv>;

beforeEach(async () => {
  db = createTestDb();
  kv = createTestKv();
  await seedCarrier(db, 1_750_000_000);
});

afterEach(() => db.close());

async function categoryId(key: string): Promise<number> {
  const categories = await listCategories(db);
  const found = categories.find((c) => c.key === key);
  if (!found) throw new Error(`no category ${key}`);
  return found.id;
}

async function insertInvoiceWithItem(
  invNum: string,
  sellerBan: string,
  sellerName: string,
  description: string,
  itemKey: string,
  amount = 100,
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO invoice (inv_num, carrier_id, inv_date, seller_ban, seller_name, amount,
                            first_seen_at, updated_at)
       VALUES (?, 1, '2026-09-01', ?, ?, ?, 1, 1)`,
    )
    .bind(invNum, sellerBan, sellerName, amount)
    .run();
  const row = await db
    .prepare(
      `INSERT INTO invoice_item (inv_num, row_num, description, item_key, amount)
       VALUES (?, 1, ?, ?, ?) RETURNING id`,
    )
    .bind(invNum, description, itemKey, amount)
    .first<{ id: number }>();
  return row!.id;
}

describe('rule matching', () => {
  it('prefers an exact BAN over a name match', () => {
    const rules = [
      { match_type: 'ban' as const, pattern: '12345678', category_id: 1, priority: 100 },
      { match_type: 'name_contains' as const, pattern: '超商', category_id: 2, priority: 100 },
    ];
    expect(matchRule({ itemKey: 'x', sellerBan: '12345678', sellerName: '統一超商' }, rules)).toBe(1);
    expect(matchRule({ itemKey: 'x', sellerBan: '99999999', sellerName: '統一超商' }, rules)).toBe(2);
  });

  it('matches merchant names case- and width-insensitively', () => {
    const rules = [
      { match_type: 'name_prefix' as const, pattern: 'starbucks', category_id: 3, priority: 100 },
    ];
    expect(matchRule({ itemKey: 'x', sellerBan: null, sellerName: 'STARBUCKS 信義店' }, rules)).toBe(3);
    expect(matchRule({ itemKey: 'x', sellerBan: null, sellerName: 'ＳＴＡＲＢＵＣＫＳ' }, rules)).toBe(3);
  });
});

describe('resolution order', () => {
  const ctx = {
    itemRules: [],
    overrides: new Map([
      ['item:usb 充電線', 90],
      ['merchant:12345678', 91],
    ]),
    rules: [{ match_type: 'ban' as const, pattern: '12345678', category_id: 92, priority: 100 }],
    cache: new Map([
      ['usb 充電線', 93],
      ['牛肉麵', 94],
    ]),
  };

  it('puts an item override above a merchant override', () => {
    // Buying a phone charger at 7-ELEVEN is electronics, not groceries — the
    // reason item-level rules outrank merchant-level ones.
    const hit = resolve({ itemKey: 'usb 充電線', sellerBan: '12345678', sellerName: null }, ctx);
    expect(hit).toEqual({ categoryId: 90, source: 'override' });
  });

  it('puts a merchant override above a merchant rule', () => {
    const hit = resolve({ itemKey: '茶葉蛋', sellerBan: '12345678', sellerName: null }, ctx);
    expect(hit).toEqual({ categoryId: 91, source: 'override' });
  });

  it('falls through to the cache when no override or rule matches', () => {
    const hit = resolve({ itemKey: '牛肉麵', sellerBan: '99999999', sellerName: null }, ctx);
    expect(hit).toEqual({ categoryId: 94, source: 'cache' });
  });

  it('still prefers an item override over the cache entry for the same key', () => {
    // The cache holds 93 for this key; the override must outrank it, and the
    // override write is what poisons that stale entry.
    const hit = resolve({ itemKey: 'usb 充電線', sellerBan: '99999999', sellerName: null }, ctx);
    expect(hit).toEqual({ categoryId: 90, source: 'override' });
  });

  it('returns null when nothing free matched — the only path to a model call', () => {
    expect(resolve({ itemKey: '新產品', sellerBan: '99999999', sellerName: null }, ctx)).toBeNull();
  });
});

describe('the pipeline', () => {
  it('resolves from a merchant rule without touching a model', async () => {
    const drinks = await categoryId('drinks');
    await insertMerchantRule(db, {
      matchType: 'ban',
      pattern: '12345678',
      categoryId: drinks,
      priority: 100,
      note: null,
    });
    const itemId = await insertInvoiceWithItem(
      'AA00000001',
      '12345678',
      '統一超商',
      'CITY CAFE 拿鐵',
      'city cafe 拿鐵',
    );

    const totals = await categorizeItems(
      [
        {
          id: itemId,
          itemKey: 'city cafe 拿鐵',
          description: 'CITY CAFE 拿鐵',
          sellerBan: '12345678',
          sellerName: '統一超商',
        },
      ],
      { db, kv, now: () => 1_750_000_100, llm: null },
    );

    expect(totals.resolvedFree).toBe(1);
    expect(totals.llmCalls).toBe(0);

    const row = await db
      .prepare(`SELECT category_id, category_source FROM invoice_item WHERE id = ?`)
      .bind(itemId)
      .first<{ category_id: number; category_source: string }>();
    expect(row).toEqual({ category_id: drinks, category_source: 'merchant' });
  });

  it('counts a cache hit and bumps the entry, which is what the stats page reports', async () => {
    const dining = await categoryId('dining');
    await db.batch([
      upsertCacheStatement(db, {
        itemKey: '牛肉麵',
        categoryId: dining,
        confidence: 0.9,
        model: 'test',
        sampleDesc: '牛肉麵',
        now: 1,
      }),
    ]);
    const itemId = await insertInvoiceWithItem('AA00000002', '87654321', '麵店', '牛肉麵', '牛肉麵');

    const totals = await categorizeItems(
      [
        {
          id: itemId,
          itemKey: '牛肉麵',
          description: '牛肉麵',
          sellerBan: '87654321',
          sellerName: '麵店',
        },
      ],
      { db, kv, now: () => 2, llm: null },
    );

    expect(totals.cacheHits).toBe(1);
    const hits = await db
      .prepare(`SELECT hits FROM item_category_cache WHERE item_key = '牛肉麵'`)
      .first<{ hits: number }>();
    expect(hits?.hits).toBe(1);
  });

  it('leaves an unresolvable item NULL rather than writing it as uncategorized', async () => {
    // NULL is the queue the next run drains. Writing `uncategorized` would
    // make a model failure indistinguishable from a confident answer.
    const itemId = await insertInvoiceWithItem('AA00000003', '11112222', '新店', '未知商品', '未知商品');

    const totals = await categorizeItems(
      [
        {
          id: itemId,
          itemKey: '未知商品',
          description: '未知商品',
          sellerBan: '11112222',
          sellerName: '新店',
        },
      ],
      { db, kv, now: () => 3, llm: null },
    );

    expect(totals.uncategorized).toBe(1);
    const row = await db
      .prepare(`SELECT category_id FROM invoice_item WHERE id = ?`)
      .bind(itemId)
      .first<{ category_id: number | null }>();
    expect(row?.category_id).toBeNull();
  });
});

describe('the correction loop', () => {
  it('re-resolves every existing item with that key, not just future ones', async () => {
    // A correction that only applies going forward feels broken, because the
    // chart the user is looking at does not change.
    const electronics = await categoryId('electronics');
    const groceries = await categoryId('groceries');

    for (const invNum of ['AB00000001', 'AB00000002', 'AB00000003']) {
      const id = await insertInvoiceWithItem(
        invNum,
        '12345678',
        '統一超商',
        'USB 充電線',
        'usb 充電線',
      );
      await db
        .prepare(`UPDATE invoice_item SET category_id = ?, category_source = 'merchant' WHERE id = ?`)
        .bind(groceries, id)
        .run();
    }

    await upsertOverride(db, 'item', 'usb 充電線', electronics, 10);
    const updated = await applyOverrideToItems(db, 'usb 充電線', electronics, 10);

    expect(updated).toBe(3);
    const rows = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM invoice_item
         WHERE category_id = ? AND category_source = 'override'`,
      )
      .bind(electronics)
      .first<{ n: number }>();
    expect(rows?.n).toBe(3);
  });
});
