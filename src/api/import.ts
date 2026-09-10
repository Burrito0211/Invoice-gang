/**
 * `POST /api/import` — the replacement for `POST /api/sync`.
 *
 * Accepts a carrier CSV export as the raw request body and runs the same
 * importer the tests exercise. Two callers are expected:
 *
 *   - the dashboard, with the owner's session cookie, for a file dragged in
 *     by hand;
 *   - the local crawler, with a bearer token, because a headless script has
 *     no business juggling a login cookie.
 *
 * The credentials for the government portal never reach this endpoint. The
 * crawler holds them on the machine that runs it and sends only the resulting
 * file, which is the whole point of splitting the two.
 */
import {
  applyOverrideToItems,
  deleteCacheEntry,
  existingInvoiceNumbers,
  findRunningSyncRun,
  getCarrierByCardNo,
  listCategories,
  upsertOverride,
} from '../db/queries.js';
import { importCarrierCsv, type ImportDeps } from '../import/run.js';
import { parseCarrierCsv } from '../import/csv.js';
import { allocateDiscounts } from '../import/allocate.js';
import { categorizePreview } from '../categorize/pipeline.js';
import { itemKey } from '../categorize/normalize.js';
import { kvKey } from '../categorize/llm.js';
import { carrierKey } from '../lib/config.js';
import { ApiError, json } from './respond.js';
import type { Env, SyncTrigger, Unix } from '../types.js';

/** An import that started this recently and never finished is still running. */
const CONCURRENT_RUN_SECONDS = 600;

/** Refuse anything implausible before reading it into memory. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Machine authentication for the crawler. Returns false when `IMPORT_TOKEN`
 * is unset, so the token path cannot be enabled by accident — an absent
 * secret means cookie-only, not open.
 */
export function hasImportToken(request: Request, env: Env): boolean {
  const expected = env.IMPORT_TOKEN;
  if (typeof expected !== 'string' || expected.length < 16) return false;

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  return timingSafeEqual(match[1]!.trim(), expected);
}

/**
 * `POST /api/import/preview` — parse and categorize a CSV without writing.
 *
 * The dry run behind the preview screen: it shows the owner every invoice in
 * the file, each item's proposed category, which invoices are already
 * imported, and lets nothing touch the database until they confirm. Discounts
 * are allocated here too, so the amounts shown are what was actually spent.
 */
export async function handleImportPreview(request: Request, env: Env): Promise<Response> {
  const csv = await readCsvBody(request);
  let parsed;
  try {
    parsed = parseCarrierCsv(csv);
  } catch (err) {
    throw new ApiError(422, 'parse_failed', err instanceof Error ? err.message : String(err));
  }

  const existing = await existingInvoiceNumbers(
    env.DB,
    parsed.invoices.map((i) => i.header.invNum),
  );

  // Every positive line across the file, tagged with a synthetic id, so one
  // preview categorization covers them all rather than one call per invoice.
  const previewItems: { id: number; itemKey: string; description: string; sellerBan: string | null; sellerName: string | null }[] = [];
  const perInvoice = parsed.invoices.map((invoice) => {
    const net = allocateDiscounts(invoice.items);
    const items = invoice.items.map((item, index) => {
      const key = itemKey(item.description);
      const id = previewItems.length;
      // Discount rows are not purchases and are not classified.
      if (item.amount >= 0) {
        previewItems.push({
          id,
          itemKey: key,
          description: item.description,
          sellerBan: invoice.header.sellerBan,
          sellerName: invoice.header.sellerName,
        });
      }
      return { previewId: id, item, itemKey: key, net: net[index]! };
    });
    return { invoice, items };
  });

  const proposals = await categorizePreview(previewItems, { db: env.DB, kv: env.CACHE });

  const invoices = perInvoice.map(({ invoice, items }) => {
    const purchases = items.filter(({ item }) => item.amount >= 0);
    return {
      inv_num: invoice.header.invNum,
      inv_date: invoice.header.invDate,
      seller_name: invoice.header.sellerName,
      amount: purchases.reduce((sum, p) => sum + p.net, 0),
      masked: invoice.masked,
      already_imported: existing.has(invoice.header.invNum),
      items: purchases.map(({ previewId, item, itemKey: key, net }) => {
        const proposal = proposals.get(previewId);
        return {
          item_key: key,
          description: item.description,
          net_amount: net,
          category: proposal?.categoryKey ?? null,
          source: proposal?.source ?? null,
        };
      }),
    };
  });

  return json({ invoices, skipped_rows: parsed.skipped });
}

/** A category correction made in the preview, applied as an item override on commit. */
interface CommitOverride {
  item_key: string;
  category: string;
}

export async function handleImport(
  request: Request,
  env: Env,
  deps: Omit<ImportDeps, 'db' | 'kv'>,
  now: Unix,
): Promise<Response> {
  const carrier = await getCarrierByCardNo(env.DB, carrierKey(env));
  if (!carrier) {
    throw new ApiError(
      409,
      'no_carrier',
      'no carrier row — the first import creates it; this should not happen',
    );
  }

  const inflight = await findRunningSyncRun(env.DB, now - CONCURRENT_RUN_SECONDS);
  if (inflight) {
    throw new ApiError(409, 'import_in_progress', `run ${inflight.id} is still running`);
  }

  // Two body shapes. The watch-folder script (and any raw upload) sends the
  // CSV as text/csv and imports the whole file. The preview screen sends a
  // JSON envelope naming which invoices to include and any category the owner
  // corrected before committing.
  const { csv, include, overrides } = await readCommitBody(request);

  const url = new URL(request.url);
  const trigger: SyncTrigger = url.searchParams.get('trigger') === 'backfill' ? 'backfill' : 'manual';

  const result = await importCarrierCsv(csv, { db: env.DB, kv: env.CACHE, now: deps.now, llm: deps.llm }, {
    carrierId: carrier.id,
    trigger,
    ...(include ? { include } : {}),
  });

  // Apply the owner's corrections after the rows exist. An override outranks
  // every rule, re-resolves matching items, and poisons the stale cache entry
  // — the same effect as correcting from the dashboard, done up front.
  let corrected = 0;
  if (result.run.status !== 'error' && overrides.length > 0) {
    const categories = await listCategories(env.DB);
    for (const override of overrides) {
      const category = categories.find((c) => c.key === override.category);
      if (!category) continue;
      await upsertOverride(env.DB, 'item', override.item_key, category.id, now);
      corrected += await applyOverrideToItems(env.DB, override.item_key, category.id, now);
      await deleteCacheEntry(env.DB, override.item_key);
      await env.CACHE.delete(kvKey(override.item_key));
    }
  }

  const status = result.run.status === 'error' ? 422 : 200;
  return json(
    {
      run: result.run,
      invoices_seen: result.invoicesSeen,
      items_corrected: corrected,
      masked_invoice_numbers: result.masked,
      skipped_rows: result.skipped,
    },
    status,
  );
}

/** Read a raw CSV body, with the size guards the endpoint needs. */
async function readCsvBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) throw new ApiError(413, 'too_large', `file exceeds ${MAX_BYTES} bytes`);
  const csv = await request.text();
  if (csv.trim() === '') throw new ApiError(400, 'empty', 'request body was empty');
  if (csv.length > MAX_BYTES) throw new ApiError(413, 'too_large', 'file too large');
  return csv;
}

/**
 * Commit body: raw CSV (whole file) or a JSON envelope from the preview. The
 * JSON form carries the CSV verbatim so the importer stays the single parser
 * — the client does not re-serialize the invoices it selected.
 */
async function readCommitBody(
  request: Request,
): Promise<{ csv: string; include?: Set<string>; overrides: CommitOverride[] }> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return { csv: await readCsvBody(request), overrides: [] };
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, 'bad_json', 'body was not valid JSON');
  }
  const envelope = (body ?? {}) as {
    csv?: unknown;
    include?: unknown;
    overrides?: unknown;
  };
  if (typeof envelope.csv !== 'string' || envelope.csv.trim() === '') {
    throw new ApiError(400, 'empty', 'envelope has no csv');
  }
  if (envelope.csv.length > MAX_BYTES) throw new ApiError(413, 'too_large', 'file too large');

  const include =
    Array.isArray(envelope.include)
      ? new Set(envelope.include.filter((v): v is string => typeof v === 'string'))
      : undefined;

  const overrides: CommitOverride[] = Array.isArray(envelope.overrides)
    ? envelope.overrides.flatMap((o) => {
        const row = (o ?? {}) as { item_key?: unknown; category?: unknown };
        return typeof row.item_key === 'string' && typeof row.category === 'string'
          ? [{ item_key: row.item_key, category: row.category }]
          : [];
      })
    : [];

  return { csv: envelope.csv, ...(include ? { include } : {}), overrides };
}

/** Constant-time compare so the token cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
