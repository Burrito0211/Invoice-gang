/**
 * Persist a parsed export, then categorize what it added.
 *
 * This is what `sync/run.ts` becomes once the data source is a file. Two of
 * the five invariants in docs/SYNC.md survive the move, and they matter more
 * than they did before:
 *
 *   - **Idempotent.** Exports overlap — you download the last few months every
 *     time — so re-importing the same invoice must not duplicate it. Enforced
 *     structurally by `invoice.inv_num` and `UNIQUE (inv_num, row_num)`, not
 *     by checking before inserting.
 *   - **Monotone.** An import never deletes or blanks an existing invoice. It
 *     updates the header fields the export is authoritative for and adds
 *     items; nothing is removed.
 *
 * Resumability, boundedness and quota-safety were properties of a paginated,
 * rate-limited API. There is no quota on reading a local file and no cursor to
 * resume from, so those three no longer apply and their tests are gone.
 */
import {
  collectInsertedIds,
  countNewHeaders,
  finishSyncRun,
  getCategorizableItems,
  getSyncRun,
  insertItemStatement,
  markDetailFetched,
  updateNetAmountStatement,
  markSyncSuccess,
  selectUncategorizedItems,
  setWatermark,
  startSyncRun,
  upsertInvoiceHeaderStatement,
} from '../db/queries.js';
import { categorizeItems, type CategorizeTotals, type PipelineDeps } from '../categorize/pipeline.js';
import { itemKey } from '../categorize/normalize.js';
import { allocateDiscounts } from './allocate.js';
import { parseCarrierCsv, type ParsedInvoice } from './csv.js';
import { rocPeriodFor } from '../lib/dates.js';
import type { SyncRunRow, SyncTrigger, Unix } from '../types.js';

export interface ImportDeps {
  db: D1Database;
  kv: KVNamespace;
  now: () => Unix;
  llm: PipelineDeps['llm'];
}

export interface ImportOptions {
  carrierId: number;
  trigger: SyncTrigger;
  /** Items left uncategorized by a previous run, retried alongside the new ones. */
  retryLimit?: number;
}

export interface ImportResult {
  run: SyncRunRow;
  invoicesSeen: number;
  masked: string[];
  skipped: { line: number; reason: string }[];
}

export async function importCarrierCsv(
  csv: string,
  deps: ImportDeps,
  options: ImportOptions,
): Promise<ImportResult> {
  const startedAt = deps.now();
  const runId = await startSyncRun(deps.db, options.trigger, startedAt);

  let status: SyncRunRow['status'] = 'ok';
  let error: string | null = null;
  let headersSeen = 0;
  let headersNew = 0;
  let itemsNew = 0;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;
  let masked: string[] = [];
  let skipped: ImportResult['skipped'] = [];
  let categorize: CategorizeTotals = emptyTotals();

  try {
    const parsed = parseCarrierCsv(csv);
    skipped = parsed.skipped;
    headersSeen = parsed.invoices.length;
    masked = parsed.invoices.filter((i) => i.masked).map((i) => i.header.invNum);

    const dates = parsed.invoices.map((i) => i.header.invDate).sort();
    windowStart = dates[0] ?? null;
    windowEnd = dates[dates.length - 1] ?? null;

    const newItemIds = await persist(parsed.invoices, deps, options.carrierId);
    headersNew = newItemIds.headersNew;
    itemsNew = newItemIds.ids.length;

    // The export is a complete statement of everything up to its last date,
    // so the watermark can advance straight to it. There is no late-arrival
    // window to re-scan — a later export simply contains the late invoice.
    if (windowEnd) await setWatermark(deps.db, options.carrierId, windowEnd, deps.now());

    const fresh = await getCategorizableItems(deps.db, newItemIds.ids);
    const retries = await selectUncategorizedItems(deps.db, options.retryLimit ?? 500);
    const seen = new Set(fresh.map((i) => i.id));
    const batch = [...fresh, ...retries.filter((r) => !seen.has(r.id))];

    categorize = await categorizeItems(
      batch.map((row) => ({
        id: row.id,
        itemKey: row.item_key,
        description: row.description,
        sellerBan: row.seller_ban,
        sellerName: row.seller_name,
      })),
      { db: deps.db, kv: deps.kv, now: deps.now, llm: deps.llm },
    );

    if (categorize.llmError) status = 'partial';
    else if (skipped.length > 0) status = 'partial';
    else await markSyncSuccess(deps.db, options.carrierId, deps.now());
  } catch (err) {
    status = 'error';
    error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  }

  await finishSyncRun(deps.db, runId, {
    status,
    finishedAt: deps.now(),
    windowStart,
    windowEnd,
    headersSeen,
    headersNew,
    // Every invoice in the export arrives with its items already attached,
    // so a "detail fetch" is the same event as seeing the header.
    detailsFetched: headersNew,
    itemsNew,
    llmCalls: categorize.llmCalls,
    llmItems: categorize.llmItems,
    cacheHits: categorize.cacheHits,
    error,
  });

  const run = await getSyncRun(deps.db, runId);
  if (!run) throw new Error(`sync_run ${runId} vanished mid-import`);
  return { run, invoicesSeen: headersSeen, masked, skipped };
}

/**
 * One batch per invoice: header and items commit together, so a failure
 * partway through the file leaves whole invoices behind rather than an
 * invoice with half its lines.
 */
async function persist(
  invoices: ParsedInvoice[],
  deps: ImportDeps,
  carrierId: number,
): Promise<{ headersNew: number; ids: number[] }> {
  let headersNew = 0;
  const ids: number[] = [];

  for (const invoice of invoices) {
    const now = deps.now();
    const header = {
      ...invoice.header,
      // Not in the export, but the prize matcher needs it and the date is
      // enough to derive it.
      invPeriod: rocPeriodFor(invoice.header.invDate),
    };

    const headerResult = await deps.db.batch<{ first_seen_at: Unix }>([
      upsertInvoiceHeaderStatement(deps.db, carrierId, header, now),
    ]);
    headersNew += countNewHeaders(headerResult, now);

    if (invoice.items.length > 0) {
      // Invoice-level discounts are spread across the positive lines here,
      // where the whole invoice is in hand. Storing the raw amount and the
      // net side by side keeps the export's own numbers verifiable while the
      // charts report what was actually spent.
      const net = allocateDiscounts(invoice.items);

      const itemResult = await deps.db.batch<{ id: number }>(
        invoice.items.map((item, index) =>
          insertItemStatement(deps.db, header.invNum, item, itemKey(item.description), net[index]!),
        ),
      );
      ids.push(...collectInsertedIds(itemResult));

      // INSERT OR IGNORE leaves an existing row alone, so a re-import would
      // otherwise keep a stale allocation. Refresh it explicitly.
      await deps.db.batch(
        invoice.items.map((item, index) =>
          updateNetAmountStatement(deps.db, header.invNum, item.rowNum, net[index]!),
        ),
      );
    }

    // The items are present by definition here, so the invoice is never left
    // sitting in the detail queue the old API sync used.
    await markDetailFetched(deps.db, header.invNum, deps.now());
  }

  return { headersNew, ids };
}

function emptyTotals(): CategorizeTotals {
  return {
    resolvedFree: 0,
    cacheHits: 0,
    llmCalls: 0,
    llmItems: 0,
    uncategorized: 0,
    invalidKeys: [],
    llmError: null,
  };
}
