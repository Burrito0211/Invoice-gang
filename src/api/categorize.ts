/**
 * `POST /api/categorize` and `DELETE /api/categorize` — the correction loop.
 *
 * The feature that makes this a system rather than a demo. Writing an override
 * re-resolves every affected *existing* item immediately, not just future
 * ones: a correction that only applies going forward feels broken, because
 * the chart the user is staring at does not change.
 *
 * An override belongs to the account that wrote it and changes only that
 * account's items. It no longer deletes the classifier cache entry for its
 * key either, because the cache is shared: it does not need to — an override
 * already outranks the cache for the account that wrote it — and one person's
 * preference ("protein bars are dining, to me") is not evidence the shared
 * answer is wrong for everyone else. Deleting it would also hand every
 * account a way to erase entries every other account relies on.
 */
import {
  applyMerchantOverrideToItems,
  applyOverrideToItems,
  clearItemCategories,
  deleteOverride,
  listCategories,
  listOverrides,
  upsertOverride,
} from '../db/queries.js';
import { badRequest, json, notFound } from './respond.js';
import type { Unix } from '../types.js';

interface OverrideBody {
  scope?: unknown;
  key?: unknown;
  category?: unknown;
}

export async function handleCreateOverride(
  db: D1Database,
  accountId: number,
  request: Request,
  now: Unix,
): Promise<Response> {
  const body = (await readBody(request)) as OverrideBody;
  const { scope, key } = parseScopeAndKey(body);
  const categoryKey = typeof body.category === 'string' ? body.category : '';

  const categories = await listCategories(db);
  const category = categories.find((c) => c.key === categoryKey);
  if (!category) throw badRequest(`unknown category ${JSON.stringify(categoryKey)}`);

  await upsertOverride(db, accountId, scope, key, category.id, now);

  const updated =
    scope === 'item'
      ? await applyOverrideToItems(db, accountId, key, category.id, now)
      : await applyMerchantOverrideToItems(db, accountId, key, category.id, now);

  // "recategorized 47 items" is the moment the correction loop feels worth
  // having, so the count is the response, not a side effect.
  return json({ scope, key, category: category.key, items_updated: updated });
}

export async function handleDeleteOverride(
  db: D1Database,
  accountId: number,
  request: Request,
): Promise<Response> {
  const { scope, key } = parseScopeAndKey(await readBody(request));

  const removed = await deleteOverride(db, accountId, scope, key);
  if (removed === 0) throw notFound(`no ${scope} override for ${key}`);

  // Blanked, not re-resolved inline: `category_id IS NULL` is the queue the
  // next categorization pass drains, and one code path assigns a category.
  const cleared = await clearItemCategories(db, accountId, scope, key);

  return json({ scope, key, items_cleared: cleared });
}

export async function handleListOverrides(db: D1Database, accountId: number): Promise<Response> {
  return json({ overrides: await listOverrides(db, accountId) });
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
