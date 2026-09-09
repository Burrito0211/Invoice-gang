/**
 * `POST /api/categorize` and `DELETE /api/categorize` — the correction loop.
 *
 * The feature that makes this a system rather than a demo. Writing an override
 * re-resolves every affected *existing* item immediately, not just future
 * ones: a correction that only applies going forward feels broken, because
 * the chart the user is staring at does not change.
 *
 * It also poisons the cache entry for the key, in both KV and the table, so
 * the model's wrong answer is not still sitting there for a future rebuild.
 */
import {
  applyMerchantOverrideToItems,
  applyOverrideToItems,
  clearItemCategories,
  deleteCacheEntriesForMerchant,
  deleteCacheEntry,
  deleteOverride,
  listCategories,
  listOverrides,
  upsertOverride,
} from '../db/queries.js';
import { kvKey } from '../categorize/llm.js';
import { badRequest, json, notFound } from './respond.js';
import type { Unix } from '../types.js';

interface OverrideBody {
  scope?: unknown;
  key?: unknown;
  category?: unknown;
}

export async function handleCreateOverride(
  db: D1Database,
  kv: KVNamespace,
  request: Request,
  now: Unix,
): Promise<Response> {
  const body = (await readBody(request)) as OverrideBody;
  const { scope, key } = parseScopeAndKey(body);
  const categoryKey = typeof body.category === 'string' ? body.category : '';

  const categories = await listCategories(db);
  const category = categories.find((c) => c.key === categoryKey);
  if (!category) throw badRequest(`unknown category ${JSON.stringify(categoryKey)}`);

  await upsertOverride(db, scope, key, category.id, now);

  const updated =
    scope === 'item'
      ? await applyOverrideToItems(db, key, category.id, now)
      : await applyMerchantOverrideToItems(db, key, category.id, now);

  let poisoned: string[];
  if (scope === 'item') {
    await deleteCacheEntry(db, key);
    poisoned = [key];
  } else {
    poisoned = await deleteCacheEntriesForMerchant(db, key);
  }
  await Promise.all(poisoned.map((k) => kv.delete(kvKey(k))));

  // "recategorized 47 items" is the moment the correction loop feels worth
  // having, so the count is the response, not a side effect.
  return json({ scope, key, category: category.key, items_updated: updated });
}

export async function handleDeleteOverride(
  db: D1Database,
  kv: KVNamespace,
  request: Request,
): Promise<Response> {
  const { scope, key } = parseScopeAndKey(await readBody(request));

  const removed = await deleteOverride(db, scope, key);
  if (removed === 0) throw notFound(`no ${scope} override for ${key}`);

  // Blanked, not re-resolved inline: `category_id IS NULL` is the queue the
  // next categorization pass drains, and one code path assigns a category.
  const cleared = await clearItemCategories(db, scope, key);
  if (scope === 'item') await kv.delete(kvKey(key));

  return json({ scope, key, items_cleared: cleared });
}

export async function handleListOverrides(db: D1Database): Promise<Response> {
  return json({ overrides: await listOverrides(db) });
}

export async function handleListCategories(db: D1Database): Promise<Response> {
  return json({ categories: await listCategories(db) });
}

// ------------------------------------------------------------------ helpers

export async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest('body must be JSON');
  }
}

function parseScopeAndKey(raw: unknown): { scope: 'item' | 'merchant'; key: string } {
  const body = (raw ?? {}) as OverrideBody;
  const scope = body.scope;
  const key = body.key;
  if (scope !== 'item' && scope !== 'merchant') {
    throw badRequest('scope must be "item" or "merchant"');
  }
  if (typeof key !== 'string' || key.trim() === '') {
    throw badRequest('key must be a non-empty string');
  }
  return { scope, key: key.trim() };
}
