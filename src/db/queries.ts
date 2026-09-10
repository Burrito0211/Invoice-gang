/**
 * Every SQL statement in the project. No query string exists anywhere else.
 *
 * The point is auditability: the data access is the thing that rots fastest
 * when it is allowed to spread across handlers, and one file means the whole
 * surface can be read in a sitting. Functions here take the `D1Database` as
 * their first argument and return plain rows — no ORM, no mapping layer, and
 * no business logic beyond what a statement expresses.
 *
 * Money is INTEGER, dates are `YYYY-MM-DD`, timestamps are unix seconds.
 */
import type {
  Category,
  CategorySource,
  InvoiceDetailRow,
  InvoiceHeader,
  InvoiceRow,
  IsoDate,
  ItemRow,
  PrizeClass,
  SyncRunRow,
  SyncStatus,
  SyncTrigger,
  Unix,
} from '../types.js';

// ------------------------------------------------------------------ carrier

export async function getCarrierByCardNo(db: D1Database, cardNo: string) {
  return db
    .prepare(`SELECT id, card_type, card_no, label, created_at FROM carrier WHERE card_no = ?`)
    .bind(cardNo)
    .first<{ id: number; card_type: string; card_no: string; label: string | null; created_at: Unix }>();
}

export async function insertCarrier(
  db: D1Database,
  carrier: { cardType: string; cardNo: string; label: string | null; createdAt: Unix },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO carrier (card_type, card_no, label, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (card_no) DO UPDATE SET card_type = excluded.card_type
       RETURNING id`,
    )
    .bind(carrier.cardType, carrier.cardNo, carrier.label, carrier.createdAt)
    .first<{ id: number }>();
  if (!row) throw new Error('carrier upsert returned no row');
  return row.id;
}

// ----------------------------------------------------------------- invoices

/**
 * Header upsert. On conflict this updates `inv_status`, `amount`,
 * `seller_name`, `updated_at` and nothing else.
 *
 * The exclusions are the load-bearing part: leaving `first_seen_at` alone is
 * what keeps re-importing an overlapping export harmless, and it is how the
 * caller tells a genuinely new invoice from one it has already seen.
 *
 * Returns whether the row was new, inferred from `first_seen_at` still being
 * the timestamp this run supplied.
 */
export function upsertInvoiceHeaderStatement(
  db: D1Database,
  carrierId: number,
  header: InvoiceHeader,
  now: Unix,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO invoice (
         inv_num, carrier_id, inv_date, inv_period, seller_ban, seller_name,
         amount, inv_status, donatable, first_seen_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (inv_num) DO UPDATE SET
         inv_status = excluded.inv_status,
         amount     = excluded.amount,
         seller_name = excluded.seller_name,
         updated_at = excluded.updated_at
       RETURNING first_seen_at`,
    )
    .bind(
      header.invNum,
      carrierId,
      header.invDate,
      header.invPeriod,
      header.sellerBan,
      header.sellerName,
      header.amount,
      header.invStatus,
      header.donatable ? 1 : 0,
      now,
      now,
    );
}

/**
 * Count the rows a batched header upsert actually created. `first_seen_at` is
 * only ever written on insert, so a row still carrying this run's timestamp is
 * a row that did not exist before it.
 *
 * This assumes `now` never repeats a value an earlier run already used — true
 * of any real clock, but it does mean a caller must not feed the sync a
 * restarting or frozen clock, or existing rows will be counted as new.
 */
export function countNewHeaders(results: D1Result<{ first_seen_at: Unix }>[], now: Unix): number {
  let count = 0;
  for (const result of results) {
    for (const row of result.results ?? []) {
      if (row.first_seen_at === now) count += 1;
    }
  }
  return count;
}

export async function markDetailFetched(db: D1Database, invNum: string, now: Unix): Promise<void> {
  await db
    .prepare(
      `UPDATE invoice
       SET detail_fetched_at = ?, detail_error = NULL, updated_at = ?
       WHERE inv_num = ?`,
    )
    .bind(now, now, invNum)
    .run();
}

/** Which of these invoice numbers already exist — for the preview's "already imported" flag. */
export async function existingInvoiceNumbers(
  db: D1Database,
  invNums: string[],
): Promise<Set<string>> {
  if (invNums.length === 0) return new Set();
  const found = new Set<string>();
  for (const batch of chunk(invNums)) {
    const { results } = await db
      .prepare(`SELECT inv_num FROM invoice WHERE inv_num IN (${placeholders(batch.length)})`)
      .bind(...batch)
      .all<{ inv_num: string }>();
    for (const row of results ?? []) found.add(row.inv_num);
  }
  return found;
}

export async function getInvoice(db: D1Database, invNum: string): Promise<InvoiceRow | null> {
  return db.prepare(`SELECT * FROM invoice WHERE inv_num = ?`).bind(invNum).first<InvoiceRow>();
}

export interface InvoiceListFilters {
  from?: IsoDate;
  to?: IsoDate;
  categoryKey?: string;
  q?: string;
  cursor?: { invDate: IsoDate; invNum: string };
  limit: number;
}

/**
 * Invoice list, newest first, keyset paginated on `(inv_date, inv_num)`.
 * Not OFFSET: it degrades over a long list and silently skips rows when new
 * invoices land mid-scroll, which for this data happens constantly.
 */
export async function listInvoices(
  db: D1Database,
  filters: InvoiceListFilters,
): Promise<(InvoiceRow & { item_count: number })[]> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filters.from) {
    where.push(`i.inv_date >= ?`);
    binds.push(filters.from);
  }
  if (filters.to) {
    where.push(`i.inv_date <= ?`);
    binds.push(filters.to);
  }
  if (filters.categoryKey) {
    where.push(
      `EXISTS (SELECT 1 FROM invoice_item it
                 JOIN category c ON c.id = it.category_id
                WHERE it.inv_num = i.inv_num AND c.key = ?)`,
    );
    binds.push(filters.categoryKey);
  }
  if (filters.q) {
    // Bound twice rather than with a numbered parameter: D1 binds positionally
    // and mixing `?` with `?1` in one statement is a trap.
    where.push(
      `(i.seller_name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM invoice_item it
                    WHERE it.inv_num = i.inv_num AND it.description LIKE ? ESCAPE '\\'))`,
    );
    const like = `%${escapeLike(filters.q)}%`;
    binds.push(like, like);
  }
  if (filters.cursor) {
    where.push(`(i.inv_date < ? OR (i.inv_date = ? AND i.inv_num < ?))`);
    binds.push(filters.cursor.invDate, filters.cursor.invDate, filters.cursor.invNum);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT i.*, (SELECT COUNT(*) FROM invoice_item it WHERE it.inv_num = i.inv_num) AS item_count
       FROM invoice i
       ${clause}
       ORDER BY i.inv_date DESC, i.inv_num DESC
       LIMIT ?`,
    )
    .bind(...binds, filters.limit)
    .all<InvoiceRow & { item_count: number }>();
  return results ?? [];
}

// -------------------------------------------------------------------- items

/**
 * Item insert. `INSERT OR IGNORE` against `UNIQUE (inv_num, row_num)` is what
 * makes re-importing an export idempotent — the uniqueness is enforced
 * structurally rather than by reading before writing.
 *
 * `RETURNING id` yields no row when the insert was ignored, so the caller
 * learns which items are genuinely new without a second query.
 */
export function insertItemStatement(
  db: D1Database,
  invNum: string,
  detail: InvoiceDetailRow,
  itemKey: string,
  netAmount: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO invoice_item
         (inv_num, row_num, description, item_key, quantity, unit_price, amount, net_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      invNum,
      detail.rowNum,
      detail.description,
      itemKey,
      detail.quantity,
      detail.unitPrice,
      detail.amount,
      netAmount,
    );
}

/**
 * Refresh the derived net amount on a row that already exists. Re-importing
 * an overlapping export must not leave an old allocation in place, and
 * `INSERT OR IGNORE` by design does not update.
 */
export function updateNetAmountStatement(
  db: D1Database,
  invNum: string,
  rowNum: number,
  netAmount: number,
): D1PreparedStatement {
  return db
    .prepare(`UPDATE invoice_item SET net_amount = ? WHERE inv_num = ? AND row_num = ?`)
    .bind(netAmount, invNum, rowNum);
}

/** The ids a batched item insert actually created; ignored rows return none. */
export function collectInsertedIds(results: D1Result<{ id: number }>[]): number[] {
  const ids: number[] = [];
  for (const result of results) {
    for (const row of result.results ?? []) ids.push(row.id);
  }
  return ids;
}

export async function getItemsByIds(db: D1Database, ids: number[]): Promise<ItemRow[]> {
  if (ids.length === 0) return [];
  const out: ItemRow[] = [];
  for (const batch of chunk(ids)) {
    const { results } = await db
      .prepare(`SELECT * FROM invoice_item WHERE id IN (${placeholders(batch.length)})`)
      .bind(...batch)
      .all<ItemRow>();
    out.push(...(results ?? []));
  }
  return out;
}

export async function getItemsForInvoice(
  db: D1Database,
  invNum: string,
): Promise<(ItemRow & { category_key: string | null; category_label_en: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT it.*, c.key AS category_key, c.label_en AS category_label_en
       FROM invoice_item it
       LEFT JOIN category c ON c.id = it.category_id
       WHERE it.inv_num = ?
       ORDER BY it.row_num`,
    )
    .bind(invNum)
    .all<ItemRow & { category_key: string | null; category_label_en: string | null }>();
  return results ?? [];
}

/**
 * Mark one line item as the owner's spending or not. An excluded item stays on
 * its invoice — the paper total must still reconcile — but drops out of every
 * spend aggregation. Returns whether a row was actually changed.
 */
export async function setItemExcluded(
  db: D1Database,
  itemId: number,
  excluded: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE invoice_item SET excluded = ? WHERE id = ?`)
    .bind(excluded ? 1 : 0, itemId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ------------------------------------------------------------------- income

export interface IncomeRow {
  id: number;
  date: IsoDate;
  amount: number;
  source: string;
  note: string | null;
  created_at: Unix;
}

export async function insertIncome(
  db: D1Database,
  entry: { date: IsoDate; amount: number; source: string; note: string | null; now: Unix },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO income (date, amount, source, note, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(entry.date, entry.amount, entry.source, entry.note, entry.now)
    .first<{ id: number }>();
  if (!row) throw new Error('income insert returned no row');
  return row.id;
}

export async function listIncome(db: D1Database, from: IsoDate, to: IsoDate): Promise<IncomeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, date, amount, source, note, created_at
       FROM income WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC`,
    )
    .bind(from, to)
    .all<IncomeRow>();
  return results ?? [];
}

export async function deleteIncome(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM income WHERE id = ?`).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function incomeTotalForRange(
  db: D1Database,
  from: IsoDate,
  to: IsoDate,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM income WHERE date BETWEEN ? AND ?`)
    .bind(from, to)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** An item plus the merchant context the cascade needs to classify it. */
export interface CategorizableRow {
  id: number;
  item_key: string;
  description: string;
  seller_ban: string | null;
  seller_name: string | null;
}

/**
 * Discount rows are excluded everywhere this feeds: they are not purchases,
 * and classifying "折扣（10％）" would spend a model call to file an
 * accounting adjustment under a spending category.
 */
const CATEGORIZABLE_SELECT = `SELECT it.id, it.item_key, it.description, i.seller_ban, i.seller_name
   FROM invoice_item it
   JOIN invoice i ON i.inv_num = it.inv_num`;

export async function getCategorizableItems(
  db: D1Database,
  ids: number[],
): Promise<CategorizableRow[]> {
  if (ids.length === 0) return [];
  const out: CategorizableRow[] = [];
  for (const batch of chunk(ids)) {
    const { results } = await db
      .prepare(`${CATEGORIZABLE_SELECT} WHERE it.id IN (${placeholders(batch.length)}) AND it.amount >= 0`)
      .bind(...batch)
      .all<CategorizableRow>();
    out.push(...(results ?? []));
  }
  return out;
}

/**
 * Items still awaiting a category — the retry queue. A model failure or a
 * cleared override leaves `category_id` NULL, and this is what drains it on
 * the next run, so there is one path that assigns a category and not two.
 */
export async function selectUncategorizedItems(
  db: D1Database,
  limit: number,
): Promise<CategorizableRow[]> {
  const { results } = await db
    .prepare(`${CATEGORIZABLE_SELECT} WHERE it.category_id IS NULL AND it.amount >= 0 ORDER BY it.id LIMIT ?`)
    .bind(limit)
    .all<CategorizableRow>();
  return results ?? [];
}

export async function setItemCategory(
  db: D1Database,
  itemId: number,
  categoryId: number,
  source: CategorySource,
  now: Unix,
): Promise<void> {
  await db
    .prepare(
      `UPDATE invoice_item
       SET category_id = ?, category_source = ?, categorized_at = ?
       WHERE id = ?`,
    )
    .bind(categoryId, source, now, itemId)
    .run();
}

/** Prepared form of the above, for batching a run's worth of updates. */
export function setItemCategoryStatement(
  db: D1Database,
  itemId: number,
  categoryId: number,
  source: CategorySource,
  now: Unix,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE invoice_item
       SET category_id = ?, category_source = ?, categorized_at = ?
       WHERE id = ?`,
    )
    .bind(categoryId, source, now, itemId);
}

/**
 * The correction loop's whole point: an override re-resolves every affected
 * *existing* item, not just future ones. A fix that only applies going
 * forward feels broken, because the chart the user is looking at does not
 * change. Returns the number of rows touched, which the UI reports back.
 */
export async function applyOverrideToItems(
  db: D1Database,
  itemKey: string,
  categoryId: number,
  now: Unix,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE invoice_item
       SET category_id = ?, category_source = 'override', categorized_at = ?
       WHERE item_key = ?`,
    )
    .bind(categoryId, now, itemKey)
    .run();
  return result.meta.changes ?? 0;
}

export async function applyMerchantOverrideToItems(
  db: D1Database,
  sellerBan: string,
  categoryId: number,
  now: Unix,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE invoice_item
       SET category_id = ?, category_source = 'override', categorized_at = ?
       WHERE inv_num IN (SELECT inv_num FROM invoice WHERE seller_ban = ?)
         AND item_key NOT IN (SELECT key FROM user_override WHERE scope = 'item')`,
    )
    .bind(categoryId, now, sellerBan)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Clearing an override sends its items back down the cascade. They are blanked
 * rather than re-resolved inline: `category_id IS NULL` is the queue the next
 * categorization pass drains, so there is one code path that assigns a
 * category and not two.
 */
export async function clearItemCategories(
  db: D1Database,
  scope: 'item' | 'merchant',
  key: string,
): Promise<number> {
  const sql =
    scope === 'item'
      ? `UPDATE invoice_item SET category_id = NULL, category_source = NULL, categorized_at = NULL
         WHERE item_key = ?`
      : `UPDATE invoice_item SET category_id = NULL, category_source = NULL, categorized_at = NULL
         WHERE inv_num IN (SELECT inv_num FROM invoice WHERE seller_ban = ?)`;
  const result = await db.prepare(sql).bind(key).run();
  return result.meta.changes ?? 0;
}

/**
 * The review queue, sorted by amount descending — correcting the expensive
 * mistakes first is the fastest route to an accurate chart.
 */
export async function listReviewItems(
  db: D1Database,
  options: { uncategorized: boolean; lowConfidence: boolean; threshold: number; limit: number },
) {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (options.uncategorized) {
    conditions.push(`(it.category_id IS NULL OR c.key = 'uncategorized')`);
  }
  if (options.lowConfidence) {
    conditions.push(`(cache.confidence IS NOT NULL AND cache.confidence < ?)`);
    binds.push(options.threshold);
  }
  // The reason filters are OR'd together, but the discount exclusion applies
  // to all of them — and AND binds tighter than OR, so without the brackets
  // `A OR B AND excluded` reads as `A OR (B AND excluded)` and discount rows
  // come back through the first branch.
  // An excluded item is not the owner's spending, so it never needs review.
  const reasons = conditions.length > 0 ? `(${conditions.join(' OR ')}) AND ` : '';
  const clause = `WHERE ${reasons}it.amount >= 0 AND it.excluded = 0`;

  const { results } = await db
    .prepare(
      `SELECT it.id, it.inv_num, it.description, it.item_key,
              COALESCE(it.net_amount, it.amount) AS amount,
              it.category_source, c.key AS category_key,
              cache.confidence, i.inv_date, i.seller_name, i.seller_ban
       FROM invoice_item it
       JOIN invoice i ON i.inv_num = it.inv_num
       LEFT JOIN category c ON c.id = it.category_id
       LEFT JOIN item_category_cache cache ON cache.item_key = it.item_key
       ${clause}
       ORDER BY COALESCE(it.net_amount, it.amount) DESC
       LIMIT ?`,
    )
    .bind(...binds, options.limit)
    .all();
  return results ?? [];
}

// --------------------------------------------------------------- categories

export async function listCategories(db: D1Database): Promise<Category[]> {
  const { results } = await db
    .prepare(`SELECT id, key, label_zh, label_en, color, sort FROM category ORDER BY sort`)
    .all<Category>();
  return results ?? [];
}

// ------------------------------------------------------------ merchant rules

export async function listMerchantRules(db: D1Database) {
  // Ordered so the caller can take the first match: exact BAN beats a name
  // prefix beats a substring, and `priority` (lower wins) breaks ties.
  const { results } = await db
    .prepare(
      `SELECT r.id, r.match_type, r.pattern, r.category_id, r.priority, c.key AS category_key
       FROM merchant_rule r
       JOIN category c ON c.id = r.category_id
       ORDER BY CASE r.match_type
                  WHEN 'ban' THEN 0
                  WHEN 'name_prefix' THEN 1
                  ELSE 2
                END,
                r.priority,
                length(r.pattern) DESC`,
    )
    .all<{
      id: number;
      match_type: 'ban' | 'name_prefix' | 'name_contains';
      pattern: string;
      category_id: number;
      priority: number;
      category_key: string;
    }>();
  return results ?? [];
}

/**
 * Ordered by priority, then longest pattern first: a longer pattern is the
 * more specific one, so `蒸氣眼罩` answers before `眼罩` gets a chance.
 */
export async function listItemRules(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT r.pattern, r.category_id, r.priority
       FROM item_rule r
       ORDER BY r.priority, length(r.pattern) DESC`,
    )
    .all<{ pattern: string; category_id: number; priority: number }>();
  return results ?? [];
}

export async function insertMerchantRule(
  db: D1Database,
  rule: { matchType: string; pattern: string; categoryId: number; priority: number; note: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO merchant_rule (match_type, pattern, category_id, priority, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (match_type, pattern) DO UPDATE SET
         category_id = excluded.category_id,
         priority    = excluded.priority,
         note        = excluded.note`,
    )
    .bind(rule.matchType, rule.pattern, rule.categoryId, rule.priority, rule.note)
    .run();
}

/**
 * The maintenance loop from docs/CATEGORIZATION.md: the merchants whose items
 * are still costing model calls. Twenty rules off the top of this list cover
 * the large majority of items, because personal spending is concentrated.
 */
export async function topUnruledMerchants(db: D1Database, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT i.seller_ban, i.seller_name, COUNT(*) AS n, SUM(COALESCE(it.net_amount, it.amount)) AS total
       FROM invoice_item it
       JOIN invoice i ON i.inv_num = it.inv_num
       WHERE it.category_source IN ('llm', 'none')
       GROUP BY i.seller_ban
       ORDER BY n DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}

// ---------------------------------------------------------------- overrides

export async function listOverrides(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.scope, o.key, o.category_id, o.created_at, c.key AS category_key
       FROM user_override o
       JOIN category c ON c.id = o.category_id
       ORDER BY o.created_at DESC`,
    )
    .all<{
      id: number;
      scope: 'item' | 'merchant';
      key: string;
      category_id: number;
      created_at: Unix;
      category_key: string;
    }>();
  return results ?? [];
}

export async function upsertOverride(
  db: D1Database,
  scope: 'item' | 'merchant',
  key: string,
  categoryId: number,
  now: Unix,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_override (scope, key, category_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET
         category_id = excluded.category_id,
         created_at  = excluded.created_at`,
    )
    .bind(scope, key, categoryId, now)
    .run();
}

export async function deleteOverride(
  db: D1Database,
  scope: 'item' | 'merchant',
  key: string,
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM user_override WHERE scope = ? AND key = ?`)
    .bind(scope, key)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------- classifier cache

/**
 * The table half of the cache. KV is the hot read path; this exists so the
 * cache is inspectable, exportable and rebuildable, and so the hit rate can
 * be computed in SQL instead of by scanning KV.
 */
export async function getCachedCategories(
  db: D1Database,
  itemKeys: string[],
): Promise<{ item_key: string; category_id: number; confidence: number | null }[]> {
  if (itemKeys.length === 0) return [];
  const out: { item_key: string; category_id: number; confidence: number | null }[] = [];
  // Chunked: an import's worth of keys exceeds D1's bound-parameter limit.
  for (const batch of chunk(itemKeys)) {
    const { results } = await db
      .prepare(
        `SELECT item_key, category_id, confidence
         FROM item_category_cache
         WHERE item_key IN (${placeholders(batch.length)})`,
      )
      .bind(...batch)
      .all<{ item_key: string; category_id: number; confidence: number | null }>();
    out.push(...(results ?? []));
  }
  return out;
}

export function upsertCacheStatement(
  db: D1Database,
  entry: {
    itemKey: string;
    categoryId: number;
    confidence: number | null;
    model: string;
    sampleDesc: string;
    now: Unix;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO item_category_cache
         (item_key, category_id, confidence, model, sample_desc, created_at, hits)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (item_key) DO UPDATE SET
         category_id = excluded.category_id,
         confidence  = excluded.confidence,
         model       = excluded.model`,
    )
    .bind(
      entry.itemKey,
      entry.categoryId,
      entry.confidence,
      entry.model,
      entry.sampleDesc,
      entry.now,
    );
}

/** Chunked, so a large import does not exceed D1's bound-parameter limit. */
export function bumpCacheHitsStatements(
  db: D1Database,
  itemKeys: string[],
): D1PreparedStatement[] {
  return chunk(itemKeys).map((batch) =>
    db
      .prepare(
        `UPDATE item_category_cache
         SET hits = hits + 1
         WHERE item_key IN (${placeholders(batch.length)})`,
      )
      .bind(...batch),
  );
}

/**
 * An override poisons the cache entry for its key: leaving the model's wrong
 * answer sitting there would resurrect it on any future cache rebuild.
 */
export async function deleteCacheEntry(db: D1Database, itemKey: string): Promise<void> {
  await db.prepare(`DELETE FROM item_category_cache WHERE item_key = ?`).bind(itemKey).run();
}

export async function deleteCacheEntriesForMerchant(
  db: D1Database,
  sellerBan: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT it.item_key
       FROM invoice_item it
       JOIN invoice i ON i.inv_num = it.inv_num
       WHERE i.seller_ban = ?`,
    )
    .bind(sellerBan)
    .all<{ item_key: string }>();
  const keys = (results ?? []).map((r) => r.item_key);
  for (const batch of chunk(keys)) {
    await db
      .prepare(`DELETE FROM item_category_cache WHERE item_key IN (${placeholders(batch.length)})`)
      .bind(...batch)
      .run();
  }
  return keys;
}

// --------------------------------------------------------------- sync state

export async function getSyncState(db: D1Database, carrierId: number) {
  return db
    .prepare(
      `SELECT carrier_id, synced_through, last_run_at, last_success_at
       FROM sync_state WHERE carrier_id = ?`,
    )
    .bind(carrierId)
    .first<{
      carrier_id: number;
      synced_through: IsoDate | null;
      last_run_at: Unix | null;
      last_success_at: Unix | null;
    }>();
}

/**
 * Advance the watermark. Called only after the headers for the chunk are
 * committed, never before the call that produces them — that ordering is the
 * whole of the resumability invariant.
 *
 * `MAX` on the existing value keeps it monotone even if a manual backfill run
 * with an older window finishes after a scheduled one.
 */
export async function setWatermark(
  db: D1Database,
  carrierId: number,
  through: IsoDate,
  now: Unix,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (carrier_id, synced_through, last_run_at)
       VALUES (?, ?, ?)
       ON CONFLICT (carrier_id) DO UPDATE SET
         synced_through = MAX(COALESCE(sync_state.synced_through, ''), excluded.synced_through),
         last_run_at    = excluded.last_run_at`,
    )
    .bind(carrierId, through, now)
    .run();
}

export async function markSyncSuccess(db: D1Database, carrierId: number, now: Unix): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (carrier_id, last_run_at, last_success_at)
       VALUES (?, ?, ?)
       ON CONFLICT (carrier_id) DO UPDATE SET
         last_run_at     = excluded.last_run_at,
         last_success_at = excluded.last_success_at`,
    )
    .bind(carrierId, now, now)
    .run();
}

export async function startSyncRun(
  db: D1Database,
  trigger: SyncTrigger,
  now: Unix,
): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO sync_run (started_at, trigger) VALUES (?, ?) RETURNING id`)
    .bind(now, trigger)
    .first<{ id: number }>();
  if (!row) throw new Error('sync_run insert returned no row');
  return row.id;
}

export async function finishSyncRun(
  db: D1Database,
  runId: number,
  update: {
    status: SyncStatus;
    finishedAt: Unix;
    windowStart: IsoDate | null;
    windowEnd: IsoDate | null;
    headersSeen: number;
    headersNew: number;
    detailsFetched: number;
    itemsNew: number;
    llmCalls: number;
    llmItems: number;
    cacheHits: number;
    error: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_run SET
         finished_at = ?, status = ?, window_start = ?, window_end = ?,
         headers_seen = ?, headers_new = ?, details_fetched = ?, items_new = ?,
         llm_calls = ?, llm_items = ?, cache_hits = ?, error = ?
       WHERE id = ?`,
    )
    .bind(
      update.finishedAt,
      update.status,
      update.windowStart,
      update.windowEnd,
      update.headersSeen,
      update.headersNew,
      update.detailsFetched,
      update.itemsNew,
      update.llmCalls,
      update.llmItems,
      update.cacheHits,
      update.error,
      runId,
    )
    .run();
}

export async function getSyncRun(db: D1Database, runId: number): Promise<SyncRunRow | null> {
  return db.prepare(`SELECT * FROM sync_run WHERE id = ?`).bind(runId).first<SyncRunRow>();
}

export async function listSyncRuns(db: D1Database, limit: number): Promise<SyncRunRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sync_run ORDER BY started_at DESC LIMIT ?`)
    .bind(limit)
    .all<SyncRunRow>();
  return results ?? [];
}

/**
 * Concurrency guard for `POST /api/sync`: a run started recently that never
 * finished. Racing two syncs would double the quota burn for no extra data.
 */
export async function findRunningSyncRun(
  db: D1Database,
  since: Unix,
): Promise<SyncRunRow | null> {
  return db
    .prepare(
      `SELECT * FROM sync_run
       WHERE finished_at IS NULL AND started_at >= ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(since)
    .first<SyncRunRow>();
}

// ------------------------------------------------------------------ prizes

export function insertWinningNumberStatement(
  db: D1Database,
  entry: { invPeriod: string; prizeClass: PrizeClass; number: string; now: Unix },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR REPLACE INTO winning_number (inv_period, prize_class, number, fetched_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(entry.invPeriod, entry.prizeClass, entry.number, entry.now);
}

export async function getWinningNumbers(db: D1Database, invPeriod: string) {
  const { results } = await db
    .prepare(
      `SELECT inv_period, prize_class, number, fetched_at
       FROM winning_number WHERE inv_period = ?`,
    )
    .bind(invPeriod)
    .all<{ inv_period: string; prize_class: PrizeClass; number: string; fetched_at: Unix }>();
  return results ?? [];
}

export async function listInvoiceNumbersForPeriod(
  db: D1Database,
  invPeriod: string,
  range: { start: IsoDate; end: IsoDate },
): Promise<{ inv_num: string }[]> {
  // Match on the stored period when the API supplied one, and fall back to the
  // date range when it did not — `inv_period` is optional in the header.
  const { results } = await db
    .prepare(
      `SELECT inv_num FROM invoice
       WHERE (inv_period = ? OR (inv_period IS NULL AND inv_date BETWEEN ? AND ?))
         AND (inv_status IS NULL OR inv_status <> '作廢')`,
    )
    .bind(invPeriod, range.start, range.end)
    .all<{ inv_num: string }>();
  return results ?? [];
}

export function insertPrizeHitStatement(
  db: D1Database,
  hit: {
    invNum: string;
    invPeriod: string;
    prizeClass: PrizeClass;
    amount: number;
    now: Unix;
  },
): D1PreparedStatement {
  // OR IGNORE, not OR REPLACE: a re-run must not blank `notified_at` and
  // notify a second time for the same win.
  return db
    .prepare(
      `INSERT OR IGNORE INTO prize_hit (inv_num, inv_period, prize_class, amount, matched_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(hit.invNum, hit.invPeriod, hit.prizeClass, hit.amount, hit.now);
}

export async function listUnnotifiedPrizeHits(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT p.*, i.seller_name, i.inv_date
       FROM prize_hit p JOIN invoice i ON i.inv_num = p.inv_num
       WHERE p.notified_at IS NULL
       ORDER BY p.amount DESC`,
    )
    .all<{
      inv_num: string;
      inv_period: string;
      prize_class: PrizeClass;
      amount: number;
      matched_at: Unix;
      notified_at: Unix | null;
      seller_name: string | null;
      inv_date: IsoDate;
    }>();
  return results ?? [];
}

export async function markPrizeNotified(db: D1Database, invNum: string, now: Unix): Promise<void> {
  await db
    .prepare(`UPDATE prize_hit SET notified_at = ? WHERE inv_num = ? AND notified_at IS NULL`)
    .bind(now, invNum)
    .run();
}

export async function listPrizeHits(db: D1Database, invPeriod: string) {
  const { results } = await db
    .prepare(
      `SELECT p.*, i.seller_name, i.inv_date, i.amount AS invoice_amount
       FROM prize_hit p JOIN invoice i ON i.inv_num = p.inv_num
       WHERE p.inv_period = ?
       ORDER BY p.amount DESC`,
    )
    .bind(invPeriod)
    .all();
  return results ?? [];
}

// -------------------------------------------------------------- aggregates

/**
 * Monthly spend by category, straight off the view. The view owns the
 * cancelled-invoice exclusion so the API layer has no aggregation SQL of its
 * own to drift out of sync with it.
 */
export async function monthlyByCategory(db: D1Database, fromMonth: string, toMonth: string) {
  const { results } = await db
    .prepare(
      `SELECT month, category_key, category_en, category_zh, item_count, total
       FROM v_monthly_category
       WHERE month BETWEEN ? AND ?
       ORDER BY month, total DESC`,
    )
    .bind(fromMonth, toMonth)
    .all<{
      month: string;
      category_key: string | null;
      category_en: string | null;
      category_zh: string | null;
      item_count: number;
      total: number;
    }>();
  return results ?? [];
}

export async function summaryByCategory(db: D1Database, from: IsoDate, to: IsoDate) {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(c.key, 'uncategorized') AS key,
              COALESCE(c.label_en, 'Uncategorized') AS label_en,
              COALESCE(c.label_zh, '未分類')        AS label_zh,
              c.color                               AS color,
              COUNT(*)                              AS item_count,
              SUM(COALESCE(it.net_amount, it.amount))                        AS total
       FROM invoice_item it
       JOIN invoice i ON i.inv_num = it.inv_num
       LEFT JOIN category c ON c.id = it.category_id
       WHERE i.inv_date BETWEEN ? AND ?
         AND (i.inv_status IS NULL OR i.inv_status <> '作廢')
         AND it.amount >= 0
         AND it.excluded = 0
       GROUP BY key
       ORDER BY total DESC`,
    )
    .bind(from, to)
    .all();
  return results ?? [];
}

export async function summaryByMerchant(db: D1Database, from: IsoDate, to: IsoDate) {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(i.seller_ban, '')       AS key,
              COALESCE(i.seller_name, '(unknown)') AS label_en,
              COUNT(DISTINCT i.inv_num)        AS invoice_count,
              COUNT(it.id)                     AS item_count,
              SUM(COALESCE(it.net_amount, it.amount, 0))      AS total
       FROM invoice i
       LEFT JOIN invoice_item it ON it.inv_num = i.inv_num AND it.excluded = 0
       WHERE i.inv_date BETWEEN ? AND ?
         AND (i.inv_status IS NULL OR i.inv_status <> '作廢')
       GROUP BY key
       ORDER BY total DESC`,
    )
    .bind(from, to)
    .all();
  return results ?? [];
}

export async function summaryByMonth(db: D1Database, from: IsoDate, to: IsoDate) {
  const { results } = await db
    .prepare(
      `SELECT substr(i.inv_date, 1, 7) AS key,
              substr(i.inv_date, 1, 7) AS label_en,
              COUNT(DISTINCT i.inv_num) AS invoice_count,
              COUNT(it.id)              AS item_count,
              SUM(COALESCE(it.net_amount, it.amount, 0)) AS total
       FROM invoice i
       LEFT JOIN invoice_item it ON it.inv_num = i.inv_num AND it.excluded = 0
       WHERE i.inv_date BETWEEN ? AND ?
         AND (i.inv_status IS NULL OR i.inv_status <> '作廢')
       GROUP BY key
       ORDER BY key`,
    )
    .bind(from, to)
    .all();
  return results ?? [];
}

/**
 * Totals for the range, computed from items rather than invoice headers.
 *
 * `invoice_total` is what was actually spent: the sum of the included,
 * positive, net line amounts — so a discount reduces it and an item marked
 * "not mine" drops out of it, which the header amount could not express. In
 * the file-import model every invoice always carries its items, so an
 * item-based total is complete, and this is the number the category breakdown
 * also sums to. `discount_total` is what discounts came to, reported
 * separately so the dashboard can say what was saved.
 */
export async function totalsForRange(db: D1Database, from: IsoDate, to: IsoDate) {
  return db
    .prepare(
      // Plain positional binds, the range supplied twice — D1 binds by
      // position and mixing `?` with `?1` in one statement is a trap.
      `SELECT (SELECT COUNT(*) FROM invoice i
                WHERE i.inv_date BETWEEN ? AND ?
                  AND (i.inv_status IS NULL OR i.inv_status <> '作廢')) AS invoice_count,
              COALESCE(SUM(CASE WHEN it.amount >= 0 AND it.excluded = 0
                                THEN COALESCE(it.net_amount, it.amount) ELSE 0 END), 0)
                AS invoice_total,
              COALESCE(-SUM(CASE WHEN it.amount < 0 THEN it.amount ELSE 0 END), 0)
                AS discount_total
       FROM invoice_item it
       JOIN invoice i ON i.inv_num = it.inv_num
       WHERE i.inv_date BETWEEN ? AND ?
         AND (i.inv_status IS NULL OR i.inv_status <> '作廢')`,
    )
    .bind(from, to, from, to)
    .first<{ invoice_count: number; invoice_total: number; discount_total: number }>();
}

/**
 * The four numbers from docs/CATEGORIZATION.md. They are the cost story of
 * the whole design, which is why they are computed in SQL and shown on the
 * dashboard rather than being a claim in the README.
 */
export async function classifierStats(db: D1Database) {
  const totals = await db
    .prepare(
      `SELECT COALESCE(SUM(llm_calls), 0)  AS llm_calls,
              COALESCE(SUM(llm_items), 0)  AS llm_items,
              COALESCE(SUM(cache_hits), 0) AS cache_hits
       FROM sync_run`,
    )
    .first<{ llm_calls: number; llm_items: number; cache_hits: number }>();

  const items = await db
    .prepare(
      `SELECT COUNT(*) AS item_count,
              COALESCE(SUM(COALESCE(net_amount, amount)), 0) AS item_total,
              COALESCE(SUM(CASE WHEN category_id IS NULL
                                THEN COALESCE(net_amount, amount) ELSE 0 END), 0)
                AS uncategorized_total,
              COALESCE(SUM(CASE WHEN category_id IS NULL THEN 1 ELSE 0 END), 0)
                AS uncategorized_count
       FROM invoice_item
       WHERE amount >= 0 AND excluded = 0`,
    )
    .first<{
      item_count: number;
      item_total: number;
      uncategorized_total: number;
      uncategorized_count: number;
    }>();

  const bySource = await db
    .prepare(
      `SELECT COALESCE(category_source, 'none') AS source, COUNT(*) AS n
       FROM invoice_item WHERE amount >= 0 AND excluded = 0 GROUP BY source`,
    )
    .all<{ source: string; n: number }>();

  const cache = await db
    .prepare(
      `SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits
       FROM item_category_cache`,
    )
    .first<{ entries: number; hits: number }>();

  return { totals, items, bySource: bySource.results ?? [], cache };
}

// ------------------------------------------------------------------ helpers

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/**
 * D1 caps the bound parameters in one statement, and an `IN (?, ?, …)` list
 * built from a whole import blows straight through it — a 279-row export has
 * ~190 distinct item keys and fails with "too many SQL variables". Every
 * unbounded `IN` list is therefore issued in chunks and the results
 * concatenated.
 *
 * 80 leaves room for the handful of other binds a statement might carry.
 */
const BIND_CHUNK = 80;

export function chunk<T>(items: T[], size = BIND_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `%` and `_` are wildcards in LIKE; a search box must not smuggle them in. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
