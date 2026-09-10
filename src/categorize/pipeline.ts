/**
 * Drives the cascade over a set of items.
 *
 * `rules.ts` decides, purely; `llm.ts` is the one impure escape hatch; this
 * file is the wiring between them and the database. It exists so that neither
 * of those two files has to know about the other, and so `sync/` has exactly
 * one entry point into categorization.
 *
 * The shape of a pass:
 *
 *   1. load the free context once — overrides, rules, and the cache rows for
 *      just the keys in this batch. One query each, not one per item.
 *   2. resolve everything that can be resolved for free.
 *   3. hand the distinct remainder to the model in as few calls as the batch
 *      size allows, and write the answers back to the cache.
 *   4. one batched UPDATE for the whole set.
 */
import {
  bumpCacheHitsStatements,
  getCachedCategories,
  listCategories,
  listItemRules,
  listMerchantRules,
  listOverrides,
  setItemCategoryStatement,
} from '../db/queries.js';
import { classifyAndCache, type ClassifyOptions, type UnseenItem } from './llm.js';
import { resolve, type ItemRule, type MerchantRule, type RuleContext } from './rules.js';
import type { Category, CategorySource, Unix } from '../types.js';

/** What the pipeline needs to know about one item. */
export interface CategorizableItem {
  id: number;
  itemKey: string;
  description: string;
  sellerBan: string | null;
  sellerName: string | null;
}

export interface CategorizeTotals {
  resolvedFree: number;
  cacheHits: number;
  llmCalls: number;
  llmItems: number;
  uncategorized: number;
  invalidKeys: string[];
  llmError: string | null;
}

export interface PipelineDeps {
  db: D1Database;
  kv: KVNamespace;
  now: () => Unix;
  /** Absent when there is no API key — the pass then stops after step 4. */
  llm: ClassifyOptions | null;
}

export async function categorizeItems(
  items: CategorizableItem[],
  deps: PipelineDeps,
): Promise<CategorizeTotals> {
  const totals: CategorizeTotals = {
    resolvedFree: 0,
    cacheHits: 0,
    llmCalls: 0,
    llmItems: 0,
    uncategorized: 0,
    invalidKeys: [],
    llmError: null,
  };
  if (items.length === 0) return totals;

  const now = deps.now();
  const categories = await listCategories(deps.db);
  const ctx = await loadRuleContext(deps, items, categories);

  const assignments: { id: number; categoryId: number; source: CategorySource }[] = [];
  const cacheHitKeys: string[] = [];
  const unseen = new Map<string, UnseenItem>();

  for (const item of items) {
    const hit = resolve(
      { itemKey: item.itemKey, sellerBan: item.sellerBan, sellerName: item.sellerName },
      ctx,
    );
    if (hit) {
      assignments.push({ id: item.id, categoryId: hit.categoryId, source: hit.source });
      totals.resolvedFree += 1;
      if (hit.source === 'cache') {
        totals.cacheHits += 1;
        cacheHitKeys.push(item.itemKey);
      }
      continue;
    }
    // Distinct keys only: the same new product bought three times this week is
    // one thing for the model to look at, not three.
    if (!unseen.has(item.itemKey)) {
      unseen.set(item.itemKey, {
        itemKey: item.itemKey,
        sampleDesc: item.description,
        sellerName: item.sellerName,
      });
    }
  }

  if (unseen.size > 0 && deps.llm) {
    const classified = await classifyAndCache(
      deps.db,
      deps.kv,
      [...unseen.values()],
      categories,
      deps.llm,
      now,
    );
    totals.llmCalls = classified.calls;
    totals.llmItems = classified.itemsSent;
    totals.invalidKeys = classified.invalidKeys;
    totals.llmError = classified.error;

    for (const item of items) {
      const answer = classified.assignments.get(item.itemKey);
      if (answer) assignments.push({ id: item.id, categoryId: answer.categoryId, source: 'llm' });
    }
  }

  // Anything still unresolved stays NULL rather than being written as
  // `uncategorized`: NULL is the queue the next run drains, and a model
  // failure must not look like a confident answer.
  const assigned = new Set(assignments.map((a) => a.id));
  totals.uncategorized = items.filter((i) => !assigned.has(i.id)).length;

  const writes = assignments.map((a) =>
    setItemCategoryStatement(deps.db, a.id, a.categoryId, a.source, now),
  );
  if (cacheHitKeys.length > 0) {
    writes.push(...bumpCacheHitsStatements(deps.db, [...new Set(cacheHitKeys)]));
  }
  if (writes.length > 0) await deps.db.batch(writes);

  return totals;
}

/**
 * Resolve categories without writing anything — the dry run behind the import
 * preview screen.
 *
 * Only the free steps of the cascade run (override → item rule → merchant rule
 * → cache); the model is never called, because the point of a preview is to
 * show what will happen instantly and reversibly, and a model call is neither.
 * An item the rules cannot place comes back `null`, which the UI shows as
 * "not yet classified" — the same state a real import would leave it in until
 * corrected.
 */
export async function categorizePreview(
  items: CategorizableItem[],
  deps: Pick<PipelineDeps, 'db' | 'kv'>,
): Promise<Map<number, { categoryKey: string; source: CategorySource }>> {
  const out = new Map<number, { categoryKey: string; source: CategorySource }>();
  if (items.length === 0) return out;

  const categories = await listCategories(deps.db);
  const keyById = new Map(categories.map((c) => [c.id, c.key]));
  // loadRuleContext only reads, so a throwaway `now`/`llm` is harmless here.
  const ctx = await loadRuleContext({ ...deps, now: () => 0, llm: null }, items, categories);

  for (const item of items) {
    const hit = resolve(
      { itemKey: item.itemKey, sellerBan: item.sellerBan, sellerName: item.sellerName },
      ctx,
    );
    const key = hit && keyById.get(hit.categoryId);
    if (hit && key) out.set(item.id, { categoryKey: key, source: hit.source });
  }
  return out;
}

/**
 * The free context, loaded once per pass.
 *
 * Cache lookups read the `item_category_cache` table, in chunks, rather than
 * hitting KV once per key. A real import carries a couple of hundred distinct
 * item keys, and one KV round trip each is a couple of hundred subrequests in
 * a single request — well past what a Worker will do, for a cache that a
 * rules-only setup never populates in the first place. The table is
 * authoritative anyway; KV remains the write-through mirror `llm.ts` keeps.
 */
async function loadRuleContext(
  deps: PipelineDeps,
  items: CategorizableItem[],
  categories: Category[],
): Promise<RuleContext> {
  const [overrideRows, itemRuleRows, ruleRows] = await Promise.all([
    listOverrides(deps.db),
    listItemRules(deps.db),
    listMerchantRules(deps.db),
  ]);

  const overrides = new Map<string, number>();
  for (const o of overrideRows) overrides.set(`${o.scope}:${o.key}`, o.category_id);

  const itemRules: ItemRule[] = itemRuleRows.map((r) => ({
    pattern: r.pattern,
    category_id: r.category_id,
    priority: r.priority,
  }));

  const rules: MerchantRule[] = ruleRows.map((r) => ({
    match_type: r.match_type,
    pattern: r.pattern,
    category_id: r.category_id,
    priority: r.priority,
  }));

  const keys = [...new Set(items.map((i) => i.itemKey))];
  const cache = new Map<string, number>();
  for (const row of await getCachedCategories(deps.db, keys)) {
    cache.set(row.item_key, row.category_id);
  }

  return { overrides, itemRules, rules, cache };
}
