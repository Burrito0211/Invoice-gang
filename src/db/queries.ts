/**
 * Every SQL statement in the project. No query string exists anywhere else.
 *
 * The point is auditability: the data access is the thing that rots fastest
 * when it is allowed to spread across handlers, and one file means the whole
 * surface can be read in a sitting. Functions here take the `D1Database` as
 * their first argument and return plain rows — no ORM, no mapping layer, and
 * no business logic beyond what a statement expresses.
 *
 * **Every function that touches a person's data takes `accountId` second, and
 * every statement it runs filters on it.** Invoices, items, overrides, income,
 * budgets and import runs all belong to one account, and a query that forgets
 * the filter is a query that shows one stranger another stranger's purchases.
 * So the id is a required positional parameter, never an optional filter that
 * can be left off. What is shared — categories, rules, winning numbers, the
 * classifier cache — takes no account, and that absence is how to tell the
 * two kinds apart at a glance. The handful of functions that read across
 * accounts on purpose (the cron's) say so.
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

// ----------------------------------------------------------------- accounts

export interface AccountRow {
  id: number;
  username: string;
  password_hash: string | null;
  notify_webhook: string | null;
  created_at: Unix;
}

export async function getAccountByUsername(
  db: D1Database,
  username: string,
): Promise<AccountRow | null> {
  return db
    .prepare(
      `SELECT id, username, password_hash, notify_webhook, created_at
       FROM account WHERE username = ?`,
    )
    .bind(username)
    .first<AccountRow>();
}

export async function getAccountById(db: D1Database, accountId: number): Promise<AccountRow | null> {
  return db
    .prepare(
      `SELECT id, username, password_hash, notify_webhook, created_at
       FROM account WHERE id = ?`,
    )
    .bind(accountId)
    .first<AccountRow>();
}

/**
 * Creates an account, or returns `null` when the username is taken. The
 * uniqueness is the table's rather than a read beforehand, so two sign-ups
 * racing for one name cannot both win it.
 */
export async function insertAccount(
  db: D1Database,
  entry: { username: string; passwordHash: string; now: Unix },
): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO account (username, password_hash, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
    )
    .bind(entry.username, entry.passwordHash, entry.now)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * The migrated owner's first sign-in: store the hash it was just verified
 * against. Only ever fills a NULL, so it cannot overwrite a password that an
 * account already has.
 */
export async function claimPasswordHash(
  db: D1Database,
  accountId: number,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare(`UPDATE account SET password_hash = ? WHERE id = ? AND password_hash IS NULL`)
    .bind(passwordHash, accountId)
    .run();
}

export async function setNotifyWebhook(
  db: D1Database,
  accountId: number,
  url: string | null,
): Promise<void> {
  await db.prepare(`UPDATE account SET notify_webhook = ? WHERE id = ?`).bind(url, accountId).run();
}

/**
 * Every account that has somewhere to be nudged, with how fresh its data is.
 * One of the cron's deliberate cross-account reads: each row is only ever
 * sent to that row's own webhook.
 */
export async function listNotifiableAccounts(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT a.id AS account_id, a.notify_webhook, s.synced_through, s.last_success_at
       FROM account a
       LEFT JOIN carrier c ON c.account_id = a.id
       LEFT JOIN sync_state s ON s.carrier_id = c.id
       WHERE a.notify_webhook IS NOT NULL`,
    )
    .all<{
      account_id: number;
      notify_webhook: string;
      synced_through: IsoDate | null;
      last_success_at: Unix | null;
    }>();
  return results ?? [];
}

// ------------------------------------------------------------ import tokens

/** One token per account. Writing a new one replaces, and so revokes, the old. */
export async function upsertImportToken(
  db: D1Database,
  accountId: number,
  tokenHash: string,
  now: Unix,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO import_token (account_id, token_hash, created_at, last_used_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT (account_id) DO UPDATE SET
         token_hash   = excluded.token_hash,
         created_at   = excluded.created_at,
         last_used_at = NULL`,
    )
    .bind(accountId, tokenHash, now)
    .run();
}

export async function deleteImportToken(db: D1Database, accountId: number): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM import_token WHERE account_id = ?`).bind(accountId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getImportToken(
  db: D1Database,
  accountId: number,
): Promise<{ created_at: Unix; last_used_at: Unix | null } | null> {
  return db
    .prepare(`SELECT created_at, last_used_at FROM import_token WHERE account_id = ?`)
    .bind(accountId)
    .first<{ created_at: Unix; last_used_at: Unix | null }>();
}

/**
 * The account a bearer token belongs to, stamping its use in the same
 * statement. Looked up by hash — the token is 256 random bits, so a plain
 * SHA-256 is enough, and the table never holds anything that would
 * authenticate on its own.
 */
export async function accountForImportToken(
  db: D1Database,
  tokenHash: string,
  now: Unix,
): Promise<number | null> {
  const row = await db
    .prepare(`UPDATE import_token SET last_used_at = ? WHERE token_hash = ? RETURNING account_id`)
    .bind(now, tokenHash)
    .first<{ account_id: number }>();
  return row?.account_id ?? null;
}

// ------------------------------------------------------------------ carrier

/** The account's carrier. One per account in v1, so the oldest is the one. */
export async function getCarrierForAccount(db: D1Database, accountId: number) {
  return db
    .prepare(
      `SELECT id, account_id, card_type, card_no, label, created_at
       FROM carrier WHERE account_id = ? ORDER BY id LIMIT 1`,
    )
    .bind(accountId)
    .first<{
      id: number;
      account_id: number;
      card_type: string;
      card_no: string;
      label: string | null;
      created_at: Unix;
    }>();
}

export async function insertCarrier(
  db: D1Database,
  accountId: number,
  carrier: { cardType: string; cardNo: string; label: string | null; createdAt: Unix },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO carrier (account_id, card_type, card_no, label, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, card_no) DO UPDATE SET card_type = excluded.card_type
       RETURNING id`,
    )
    .bind(accountId, carrier.cardType, carrier.cardNo, carrier.label, carrier.createdAt)
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
 * The conflict target is `(account_id, inv_num)`: the same invoice number in
 * two accounts is two rows, and one account's import can never rewrite the
 * other's.
 *
 * Returns whether the row was new, inferred from `first_seen_at` still being
 * the timestamp this run supplied.
 */
export function upsertInvoiceHeaderStatement(
  db: D1Database,
  accountId: number,
  carrierId: number,
  header: InvoiceHeader,
  now: Unix,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO invoice (
         account_id, inv_num, carrier_id, inv_date, inv_period, seller_ban, seller_name,
         amount, inv_status, donatable, first_seen_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, inv_num) DO UPDATE SET
         inv_status = excluded.inv_status,
         amount     = excluded.amount,
         seller_name = excluded.seller_name,
         updated_at = excluded.updated_at
       RETURNING first_seen_at`,
    )
    .bind(
      accountId,
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

export async function markDetailFetched(
  db: D1Database,
  accountId: number,
  invNum: string,
  now: Unix,
): Promise<void> {
  await db
    .prepare(
      `UPDATE invoice
       SET detail_fetched_at = ?, detail_error = NULL, updated_at = ?
       WHERE account_id = ? AND inv_num = ?`,
    )
    .bind(now, now, accountId, invNum)
    .run();
}

/**
 * Which of these invoice numbers this account already has — for the preview's
 * "already imported" flag. Another account holding the same number is not an
 * answer this can give.
 */
export async function existingInvoiceNumbers(
  db: D1Database,
  accountId: number,
  invNums: string[],
): Promise<Set<string>> {
  if (invNums.length === 0) return new Set();
  const found = new Set<string>();
  for (const batch of chunk(invNums)) {
    const { results } = await db
      .prepare(
        `SELECT inv_num FROM invoice
         WHERE account_id = ? AND inv_num IN (${placeholders(batch.length)})`,
      )
      .bind(accountId, ...batch)
      .all<{ inv_num: string }>();
    for (const row of results ?? []) found.add(row.inv_num);
  }
  return found;
}

export async function getInvoice(
  db: D1Database,
  accountId: number,
  invNum: string,
): Promise<InvoiceRow | null> {
  return db
    .prepare(`SELECT * FROM invoice WHERE account_id = ? AND inv_num = ?`)
    .bind(accountId, invNum)
    .first<InvoiceRow>();
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
  accountId: number,
  filters: InvoiceListFilters,
): Promise<(InvoiceRow & { item_count: number })[]> {
  const where: string[] = [`i.account_id = ?`];
  const binds: unknown[] = [accountId];

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
                WHERE it.account_id = i.account_id AND it.inv_num = i.inv_num AND c.key = ?)`,
    );
    binds.push(filters.categoryKey);
  }
  if (filters.q) {
    // Bound twice rather than with a numbered parameter: D1 binds positionally
    // and mixing `?` with `?1` in one statement is a trap.
    where.push(
      `(i.seller_name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM invoice_item it
                    WHERE it.account_id = i.account_id AND it.inv_num = i.inv_num
                      AND it.description LIKE ? ESCAPE '\\'))`,
    );
    const like = `%${escapeLike(filters.q)}%`;
    binds.push(like, like);
  }
  if (filters.cursor) {
    where.push(`(i.inv_date < ? OR (i.inv_date = ? AND i.inv_num < ?))`);
    binds.push(filters.cursor.invDate, filters.cursor.invDate, filters.cursor.invNum);
  }

  const { results } = await db
    .prepare(
      `SELECT i.*,
              (SELECT COUNT(*) FROM invoice_item it
                WHERE it.account_id = i.account_id AND it.inv_num = i.inv_num) AS item_count
       FROM invoice i
       WHERE ${where.join(' AND ')}
       ORDER BY i.inv_date DESC, i.inv_num DESC
       LIMIT ?`,
    )
    .bind(...binds, filters.limit)
    .all<InvoiceRow & { item_count: number }>();
  return results ?? [];
}

// -------------------------------------------------------------------- items

/**
 * Item insert. `INSERT OR IGNORE` against `UNIQUE (account_id, inv_num,
 * row_num)` is what makes re-importing an export idempotent — the uniqueness
 * is enforced structurally rather than by reading before writing.
 *
 * `RETURNING id` yields no row when the insert was ignored, so the caller
 * learns which items are genuinely new without a second query.
 */
export function insertItemStatement(
  db: D1Database,
  accountId: number,
  invNum: string,
  detail: InvoiceDetailRow,
  itemKey: string,
  netAmount: number,
  excluded = false,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO invoice_item
         (account_id, inv_num, row_num, description, item_key, quantity, unit_price, amount,
          net_amount, excluded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      accountId,
      invNum,
      detail.rowNum,
      detail.description,
      itemKey,
      detail.quantity,
      detail.unitPrice,
      detail.amount,
      netAmount,
      excluded ? 1 : 0,
    );
}

/**
 * Refresh the derived net amount on a row that already exists. Re-importing
 * an overlapping export must not leave an old allocation in place, and
 * `INSERT OR IGNORE` by design does not update.
 */
export function updateNetAmountStatement(
  db: D1Database,
  accountId: number,
  invNum: string,
  rowNum: number,
  netAmount: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE invoice_item SET net_amount = ?
       WHERE account_id = ? AND inv_num = ? AND row_num = ?`,
    )
    .bind(netAmount, accountId, invNum, rowNum);
}

/** The ids a batched item insert actually created; ignored rows return none. */
export function collectInsertedIds(results: D1Result<{ id: number }>[]): number[] {
  const ids: number[] = [];
  for (const result of results) {
    for (const row of result.results ?? []) ids.push(row.id);
  }
  return ids;
}

export async function getItemsByIds(
  db: D1Database,
  accountId: number,
  ids: number[],
): Promise<ItemRow[]> {
  if (ids.length === 0) return [];
  const out: ItemRow[] = [];
  for (const batch of chunk(ids)) {
    const { results } = await db
      .prepare(
        `SELECT * FROM invoice_item
         WHERE account_id = ? AND id IN (${placeholders(batch.length)})`,
      )
      .bind(accountId, ...batch)
      .all<ItemRow>();
    out.push(...(results ?? []));
  }
  return out;
}

export async function getItemsForInvoice(
  db: D1Database,
  accountId: number,
  invNum: string,
): Promise<(ItemRow & { category_key: string | null; category_label_en: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT it.*, c.key AS category_key, c.label_en AS category_label_en
       FROM invoice_item it
       LEFT JOIN category c ON c.id = it.category_id
       WHERE it.account_id = ? AND it.inv_num = ?
       ORDER BY it.row_num`,
    )
    .bind(accountId, invNum)
    .all<ItemRow & { category_key: string | null; category_label_en: string | null }>();
  return results ?? [];
}

/**
 * Mark one line item as the owner's spending or not. An excluded item stays on
 * its invoice — the paper total must still reconcile — but drops out of every
 * spend aggregation. Returns whether a row was actually changed, which is
 * false for an id belonging to another account.
 */
export async function setItemExcluded(
  db: D1Database,
  accountId: number,
  itemId: number,
  excluded: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE invoice_item SET excluded = ? WHERE account_id = ? AND id = ?`)
    .bind(excluded ? 1 : 0, accountId, itemId)
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
  accountId: number,
  entry: { date: IsoDate; amount: number; source: string; note: string | null; now: Unix },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO income (account_id, date, amount, source, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(accountId, entry.date, entry.amount, entry.source, entry.note, entry.now)
    .first<{ id: number }>();
  if (!row) throw new Error('income insert returned no row');
  return row.id;
}

export async function listIncome(
  db: D1Database,
  accountId: number,
  from: IsoDate,
  to: IsoDate,
): Promise<IncomeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, date, amount, source, note, created_at
       FROM income WHERE account_id = ? AND date BETWEEN ? AND ?
       ORDER BY date DESC, id DESC`,
    )
    .bind(accountId, from, to)
    .all<IncomeRow>();
  return results ?? [];
}

export async function deleteIncome(db: D1Database, accountId: number, id: number): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM income WHERE account_id = ? AND id = ?`)
    .bind(accountId, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function incomeTotalForRange(
  db: D1Database,
  accountId: number,
  from: IsoDate,
  to: IsoDate,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM income WHERE account_id = ? AND date BETWEEN ? AND ?`,
    )
    .bind(accountId, from, to)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

// ------------------------------------------------------------------ budget

export interface BudgetRow {
  month: string;
  amount: number;
}

/**
 * The budget in force for `month` — the newest row at or before it.
 *
 * A month with no row of its own is not unbudgeted; it inherits. That is what
 * makes the figure something you set once rather than a monthly chore, and it
 * is why `month` is stored at all: the rows are change points, so August is
 * still judged against August's number after September's has been set.
 */
export async function getEffectiveBudget(
  db: D1Database,
  accountId: number,
  month: string,
): Promise<BudgetRow | null> {
  return db
    .prepare(
      `SELECT month, amount FROM budget
       WHERE account_id = ? AND month <= ?
       ORDER BY month DESC LIMIT 1`,
    )
    .bind(accountId, month)
    .first<BudgetRow>();
}

export async function upsertBudget(
  db: D1Database,
  accountId: number,
  entry: { month: string; amount: number; now: Unix },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO budget (account_id, month, amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, month) DO UPDATE SET
         amount = excluded.amount, updated_at = excluded.updated_at`,
    )
    .bind(accountId, entry.month, entry.amount, entry.now, entry.now)
    .run();
}

/**
 * Removes one change point. The month then inherits from the row before it
 * again, so this undoes a budget change rather than leaving the month with no
 * budget at all — unless it was the only row.
 */
export async function deleteBudget(db: D1Database, accountId: number, month: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM budget WHERE account_id = ? AND month = ?`)
    .bind(accountId, month)
    .run();
  return (result.meta.changes ?? 0) > 0;
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
   JOIN invoice i ON i.account_id = it.account_id AND i.inv_num = it.inv_num`;

export async function getCategorizableItems(
  db: D1Database,
  accountId: number,
  ids: number[],
): Promise<CategorizableRow[]> {
  if (ids.length === 0) return [];
  const out: CategorizableRow[] = [];
  for (const batch of chunk(ids)) {
    const { results } = await db
      .prepare(
        `${CATEGORIZABLE_SELECT}
         WHERE it.account_id = ? AND it.id IN (${placeholders(batch.length)}) AND it.amount >= 0`,
      )
      .bind(accountId, ...batch)
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
  accountId: number,
  limit: number,
): Promise<CategorizableRow[]> {
  const { results } = await db
    .prepare(
      `${CATEGORIZABLE_SELECT}
       WHERE it.account_id = ? AND it.category_id IS NULL AND it.amount >= 0
       ORDER BY it.id LIMIT ?`,
    )
    .bind(accountId, limit)
    .all<CategorizableRow>();
  return results ?? [];
}

/**
 * By item id alone: every caller got its ids from an account-scoped read in
 * the same pass, so the id already implies the account.
 */
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
 *
 * Only this account's items: the same product bought by someone else keeps
 * whatever category their own cascade gave it.
 */
export async function applyOverrideToItems(
  db: D1Database,
  accountId: number,
  itemKey: string,
  categoryId: number,
  now: Unix,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE invoice_item
       SET category_id = ?, category_source = 'override', categorized_at = ?
       WHERE account_id = ? AND item_key = ?`,
    )
    .bind(categoryId, now, accountId, itemKey)
    .run();
  return result.meta.changes ?? 0;
}

export async function applyMerchantOverrideToItems(
  db: D1Database,
  accountId: number,
  sellerBan: string,
  categoryId: number,
  now: Unix,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE invoice_item
       SET category_id = ?, category_source = 'override', categorized_at = ?
       WHERE account_id = ?
         AND inv_num IN (SELECT inv_num FROM invoice WHERE account_id = ? AND seller_ban = ?)
         AND item_key NOT IN (SELECT key FROM user_override
                               WHERE account_id = ? AND scope = 'item')`,
    )
    .bind(categoryId, now, accountId, accountId, sellerBan, accountId)
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
  accountId: number,
  scope: 'item' | 'merchant',
  key: string,
): Promise<number> {
  const sql =
    scope === 'item'
      ? `UPDATE invoice_item SET category_id = NULL, category_source = NULL, categorized_at = NULL
         WHERE account_id = ? AND item_key = ?`
      : `UPDATE invoice_item SET category_id = NULL, category_source = NULL, categorized_at = NULL
         WHERE account_id = ?
           AND inv_num IN (SELECT inv_num FROM invoice WHERE account_id = ? AND seller_ban = ?)`;
  const statement = db.prepare(sql);
  const bound = scope === 'item' ? statement.bind(accountId, key) : statement.bind(accountId, accountId, key);
  const result = await bound.run();
  return result.meta.changes ?? 0;
}

/**
 * The review queue, sorted by amount descending — correcting the expensive
 * mistakes first is the fastest route to an accurate chart.
 */
export async function listReviewItems(
  db: D1Database,
  accountId: number,
  options: { uncategorized: boolean; lowConfidence: boolean; threshold: number; limit: number },
) {
  const conditions: string[] = [];
  const binds: unknown[] = [accountId];

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
  const clause = `WHERE it.account_id = ? AND ${reasons}it.amount >= 0 AND it.excluded = 0`;

  const { results } = await db
    .prepare(
      `SELECT it.id, it.inv_num, it.description, it.item_key,
              COALESCE(it.net_amount, it.amount) AS amount,
              it.category_source, c.key AS category_key,
              cache.confidence, i.inv_date, i.seller_name, i.seller_ban
       FROM invoice_item it
       JOIN invoice i ON i.account_id = it.account_id AND i.inv_num = it.inv_num
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
export async function topUnruledMerchants(db: D1Database, accountId: number, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT i.seller_ban, i.seller_name, COUNT(*) AS n, SUM(COALESCE(it.net_amount, it.amount)) AS total
       FROM invoice_item it
       JOIN invoice i ON i.account_id = it.account_id AND i.inv_num = it.inv_num
       WHERE it.account_id = ? AND it.category_source IN ('llm', 'none')
       GROUP BY i.seller_ban
       ORDER BY n DESC
       LIMIT ?`,
    )
    .bind(accountId, limit)
    .all();
  return results ?? [];
}

// ---------------------------------------------------------------- overrides

export async function listOverrides(db: D1Database, accountId: number) {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.scope, o.key, o.category_id, o.created_at, c.key AS category_key
       FROM user_override o
       JOIN category c ON c.id = o.category_id
       WHERE o.account_id = ?
       ORDER BY o.created_at DESC`,
    )
    .bind(accountId)
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
  accountId: number,
  scope: 'item' | 'merchant',
  key: string,
  categoryId: number,
  now: Unix,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_override (account_id, scope, key, category_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, scope, key) DO UPDATE SET
         category_id = excluded.category_id,
         created_at  = excluded.created_at`,
    )
    .bind(accountId, scope, key, categoryId, now)
    .run();
}

export async function deleteOverride(
  db: D1Database,
  accountId: number,
  scope: 'item' | 'merchant',
  key: string,
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM user_override WHERE account_id = ? AND scope = ? AND key = ?`)
    .bind(accountId, scope, key)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------- classifier cache

/**
 * The table half of the cache. KV is the hot read path; this exists so the
 * cache is inspectable, exportable and rebuildable, and so the hit rate can
 * be computed in SQL instead of by scanning KV.
 *
 * Shared by every account. It maps a product string to a category, which is
 * the same answer whoever bought the product.
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

// --------------------------------------------------------------- sync state

/** Keyed by carrier; callers get the carrier id from `getCarrierForAccount`. */
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
  accountId: number,
  trigger: SyncTrigger,
  now: Unix,
): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO sync_run (account_id, started_at, trigger) VALUES (?, ?, ?) RETURNING id`)
    .bind(accountId, now, trigger)
    .first<{ id: number }>();
  if (!row) throw new Error('sync_run insert returned no row');
  return row.id;
}

/** By run id: only ever called with the id `startSyncRun` just returned. */
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

/** By run id, for the same reason as `finishSyncRun`. */
export async function getSyncRun(db: D1Database, runId: number): Promise<SyncRunRow | null> {
  return db.prepare(`SELECT * FROM sync_run WHERE id = ?`).bind(runId).first<SyncRunRow>();
}

export async function listSyncRuns(
  db: D1Database,
  accountId: number,
  limit: number,
): Promise<SyncRunRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sync_run WHERE account_id = ? ORDER BY started_at DESC LIMIT ?`)
    .bind(accountId, limit)
    .all<SyncRunRow>();
  return results ?? [];
}

/**
 * Concurrency guard for `POST /api/import`: a run this account started
 * recently that never finished. Per account — someone else's import running
 * is no reason to refuse yours.
 */
export async function findRunningSyncRun(
  db: D1Database,
  accountId: number,
  since: Unix,
): Promise<SyncRunRow | null> {
  return db
    .prepare(
      `SELECT * FROM sync_run
       WHERE account_id = ? AND finished_at IS NULL AND started_at >= ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(accountId, since)
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

/**
 * Every account's invoices for a period. The prize check's deliberate
 * cross-account read: the winning numbers are the same for everyone, and each
 * hit is written back against the account that holds the invoice.
 */
export async function listInvoiceNumbersForPeriod(
  db: D1Database,
  invPeriod: string,
  range: { start: IsoDate; end: IsoDate },
): Promise<{ account_id: number; inv_num: string }[]> {
  // Match on the stored period when the API supplied one, and fall back to the
  // date range when it did not — `inv_period` is optional in the header.
  const { results } = await db
    .prepare(
      `SELECT account_id, inv_num FROM invoice
       WHERE (inv_period = ? OR (inv_period IS NULL AND inv_date BETWEEN ? AND ?))
         AND (inv_status IS NULL OR inv_status <> '作廢')`,
    )
    .bind(invPeriod, range.start, range.end)
    .all<{ account_id: number; inv_num: string }>();
  return results ?? [];
}

export function insertPrizeHitStatement(
  db: D1Database,
  hit: {
    accountId: number;
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
      `INSERT OR IGNORE INTO prize_hit
         (account_id, inv_num, inv_period, prize_class, amount, matched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(hit.accountId, hit.invNum, hit.invPeriod, hit.prizeClass, hit.amount, hit.now);
}

/**
 * Hits not yet sent, across accounts, each with the webhook of the account it
 * belongs to. An account with no webhook is left out rather than marked sent,
 * so setting one later still delivers the win.
 */
export async function listUnnotifiedPrizeHits(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT p.*, i.seller_name, i.inv_date, a.notify_webhook
       FROM prize_hit p
       JOIN invoice i ON i.account_id = p.account_id AND i.inv_num = p.inv_num
       JOIN account a ON a.id = p.account_id
       WHERE p.notified_at IS NULL AND a.notify_webhook IS NOT NULL
       ORDER BY p.amount DESC`,
    )
    .all<{
      account_id: number;
      inv_num: string;
      inv_period: string;
      prize_class: PrizeClass;
      amount: number;
      matched_at: Unix;
      notified_at: Unix | null;
      seller_name: string | null;
      inv_date: IsoDate;
      notify_webhook: string;
    }>();
  return results ?? [];
}

export async function markPrizeNotified(
  db: D1Database,
  accountId: number,
  invNum: string,
  now: Unix,
): Promise<void> {
  await db
    .prepare(
      `UPDATE prize_hit SET notified_at = ?
       WHERE account_id = ? AND inv_num = ? AND notified_at IS NULL`,
    )
    .bind(now, accountId, invNum)
    .run();
}

export async function listPrizeHits(db: D1Database, accountId: number, invPeriod: string) {
  const { results } = await db
    .prepare(
      `SELECT p.*, i.seller_name, i.inv_date, i.amount AS invoice_amount
       FROM prize_hit p
       JOIN invoice i ON i.account_id = p.account_id AND i.inv_num = p.inv_num
       WHERE p.account_id = ? AND p.inv_period = ?
       ORDER BY p.amount DESC`,
    )
    .bind(accountId, invPeriod)
    .all();
  return results ?? [];
}

// -------------------------------------------------------------- aggregates

/**
 * Monthly spend by category, straight off the view. The view owns the
 * cancelled-invoice exclusion so the API layer has no aggregation SQL of its
 * own to drift out of sync with it.
 */
export async function monthlyByCategory(
  db: D1Database,
  accountId: number,
  fromMonth: string,
  toMonth: string,
) {
  const { results } = await db
    .prepare(
      `SELECT month, category_key, category_en, category_zh, item_count, total
       FROM v_monthly_category
       WHERE account_id = ? AND month BETWEEN ? AND ?
       ORDER BY month, total DESC`,
    )
    .bind(accountId, fromMonth, toMonth)
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

export async function summaryByCategory(db: D1Database, accountId: number, from: IsoDate, to: IsoDate) {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(c.key, 'uncategorized') AS key,
              COALESCE(c.label_en, 'Uncategorized') AS label_en,
              COALESCE(c.label_zh, '未分類')        AS label_zh,
              c.color                               AS color,
              COUNT(*)                              AS item_count,
              SUM(COALESCE(it.net_amount, it.amount))                        AS total
       FROM invoice_item it
       JOIN invoice i ON i.account_id = it.account_id AND i.inv_num = it.inv_num
       LEFT JOIN category c ON c.id = it.category_id
       WHERE it.account_id = ?
         AND i.inv_date BETWEEN ? AND ?
         AND (i.inv_status IS NULL OR i.inv_status <> '作廢')
         AND it.amount >= 0
         AND it.excluded = 0
       GROUP BY key
       ORDER BY total DESC`,
    )
    .bind(accountId, from, to)
    .all();
  return results ?? [];
}

export async function summaryByMerchant(db: D1Database, accountId: number, from: IsoDate, to: IsoDate) {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(i.seller_ban, '')       AS key,
              COALESCE(i.seller_name, '(unknown)') AS label_en,
              COUNT(DISTINCT i.inv_num)        AS invoice_count,
              COUNT(it.id)                     AS item_count,
              SUM(COALESCE(it.net_amount, it.amount, 0))      AS total
       FROM invoice i
       LEFT JOIN invoice_item it
              ON it.account_id = i.account_id AND it.inv_num = i.inv_num AND it.excluded = 0
       WHERE i.account_id = ?
         AND i.inv_date BETWEEN ? AND ?
         AND (i.inv_status IS NULL OR i.inv_status <> '作廢')
       GROUP BY key
       ORDER BY total DESC`,
    )
    .bind(accountId, from, to)
    .all();
  return results ?? [];
}

export async function summaryByMonth(db: D1Database, accountId: number, from: IsoDate, to: IsoDate) {
  const { results } = await db
    .prepare(
      `SELECT substr(i.inv_date, 1, 7) AS key,
              substr(i.inv_date, 1, 7) AS label_en,
              COUNT(DISTINCT i.inv_num) AS invoice_count,
              COUNT(it.id)              AS item_count,
              SUM(COALESCE(it.net_amount, it.amount, 0)) AS total
       FROM invoice i
       LEFT JOIN invoice_item it
              ON it.account_id = i.account_id AND it.inv_num = i.inv_num AND it.excluded = 0
       WHERE i.account_id = ?
         AND i.inv_date BETWEEN ? AND ?
         AND (i.inv_status IS NULL OR i.inv_status <> '作廢')
       GROUP BY key
       ORDER BY key`,
    )
    .bind(accountId, from, to)
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
export async function totalsForRange(db: D1Database, accountId: number, from: IsoDate, to: IsoDate) {
  return db
    .prepare(
      // Plain positional binds, the account and range supplied twice — D1
      // binds by position and mixing `?` with `?1` in one statement is a trap.
      `SELECT (SELECT COUNT(*) FROM invoice i
                WHERE i.account_id = ?
                  AND i.inv_date BETWEEN ? AND ?
                  AND (i.inv_status IS NULL OR i.inv_status <> '作廢')) AS invoice_count,
              COALESCE(SUM(CASE WHEN it.amount >= 0 AND it.excluded = 0
                                THEN COALESCE(it.net_amount, it.amount) ELSE 0 END), 0)
                AS invoice_total,
              COALESCE(-SUM(CASE WHEN it.amount < 0 THEN it.amount ELSE 0 END), 0)
                AS discount_total
       FROM invoice_item it
       JOIN invoice i ON i.account_id = it.account_id AND i.inv_num = it.inv_num
       WHERE it.account_id = ?
         AND i.inv_date BETWEEN ? AND ?
         AND (i.inv_status IS NULL OR i.inv_status <> '作廢')`,
    )
    .bind(accountId, from, to, accountId, from, to)
    .first<{ invoice_count: number; invoice_total: number; discount_total: number }>();
}

/**
 * The four numbers from docs/CATEGORIZATION.md. They are the cost story of
 * the whole design, which is why they are computed in SQL and shown on the
 * dashboard rather than being a claim in the README.
 *
 * Runs and items are this account's; the cache is shared, so its size and
 * lifetime hits are everyone's.
 */
export async function classifierStats(db: D1Database, accountId: number) {
  const totals = await db
    .prepare(
      `SELECT COALESCE(SUM(llm_calls), 0)  AS llm_calls,
              COALESCE(SUM(llm_items), 0)  AS llm_items,
              COALESCE(SUM(cache_hits), 0) AS cache_hits
       FROM sync_run WHERE account_id = ?`,
    )
    .bind(accountId)
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
       WHERE account_id = ? AND amount >= 0 AND excluded = 0`,
    )
    .bind(accountId)
    .first<{
      item_count: number;
      item_total: number;
      uncategorized_total: number;
      uncategorized_count: number;
    }>();

  const bySource = await db
    .prepare(
      `SELECT COALESCE(category_source, 'none') AS source, COUNT(*) AS n
       FROM invoice_item WHERE account_id = ? AND amount >= 0 AND excluded = 0
       GROUP BY source`,
    )
    .bind(accountId)
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
