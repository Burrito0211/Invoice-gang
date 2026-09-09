/**
 * Orchestration and `sync_run` bookkeeping.
 *
 * A run makes progress; it is never authoritative and complete. The five
 * invariants in docs/SYNC.md hold no matter where it stops:
 *
 *   1. **Idempotent** — enforced structurally by `invoice.inv_num` as the
 *      primary key and `UNIQUE (inv_num, row_num)` on items.
 *   2. **Resumable** — the watermark advances only after committed headers.
 *   3. **Monotone** — headers update a fixed set of fields; items are only
 *      added, never deleted or blanked.
 *   4. **Bounded** — at most `detailBudget` detail calls and
 *      `headerCallBudget` header calls per run.
 *   5. **Quota-safe** — a quota error ends the run with status `quota`,
 *      commits what was done, and is not an error.
 *
 * The dependency shape is the design constraint: `runSync` takes the API
 * client, the database and a clock as parameters and constructs none of them,
 * so the test suite drives the whole algorithm with captured JSON and no
 * network.
 */
import {
  finishSyncRun,
  getCarrierByCardNo,
  getSyncRun,
  getSyncState,
  getCategorizableItems,
  markSyncSuccess,
  selectUncategorizedItems,
  startSyncRun,
} from '../db/queries.js';
import { categorizeItems, type CategorizeTotals, type PipelineDeps } from '../categorize/pipeline.js';
import { drainDetailQueue } from './details.js';
import { planWindows, syncHeaders } from './headers.js';
import { isQuotaError } from '../lib/errors.js';
import { toIsoDate } from '../lib/dates.js';
import type { EInvoiceApi } from '../einvoice/client.js';
import type { IsoDate, SyncRunRow, SyncStatus, SyncTrigger, Unix } from '../types.js';

export interface RunSyncDeps {
  api: EInvoiceApi;
  db: D1Database;
  kv: KVNamespace;
  now: () => Unix;
  /** Null disables the model step; the run still does everything else. */
  llm: PipelineDeps['llm'];
}

export interface RunSyncOptions {
  trigger: SyncTrigger;
  cardNo: string;
  overlapDays: number;
  windowDays: number;
  headerCallBudget: number;
  detailBudget: number;
  /**
   * Extra already-uncategorized items to retry alongside this run's new ones.
   * A previous model failure or a cleared override left them NULL.
   */
  retryLimit?: number;
}

export async function runSync(
  deps: RunSyncDeps,
  options: RunSyncOptions,
): Promise<SyncRunRow> {
  const startedAt = deps.now();
  const runId = await startSyncRun(deps.db, options.trigger, startedAt);

  let status: SyncStatus = 'ok';
  let error: string | null = null;
  let windowStart: IsoDate | null = null;
  let windowEnd: IsoDate | null = null;
  let headersSeen = 0;
  let headersNew = 0;
  let detailsFetched = 0;
  let itemsNew = 0;
  let categorize: CategorizeTotals = {
    resolvedFree: 0,
    cacheHits: 0,
    llmCalls: 0,
    llmItems: 0,
    uncategorized: 0,
    invalidKeys: [],
    llmError: null,
  };

  try {
    const carrier = await getCarrierByCardNo(deps.db, options.cardNo);
    if (!carrier) {
      throw new Error(`no carrier row for the configured card — seed it before syncing`);
    }
    const state = await getSyncState(deps.db, carrier.id);

    // ---------------------------------------------------------- phase 1
    const plans = planWindows({
      syncedThrough: state?.synced_through ?? null,
      carrierCreatedAt: toIsoDate(carrier.created_at),
      today: toIsoDate(deps.now()),
      overlapDays: options.overlapDays,
      windowDays: options.windowDays,
      callBudget: options.headerCallBudget,
    });

    try {
      const headers = await syncHeaders(plans, {
        api: deps.api,
        db: deps.db,
        carrierId: carrier.id,
        now: deps.now,
      });
      headersSeen = headers.headersSeen;
      headersNew = headers.headersNew;
      windowStart = headers.windowStart;
      windowEnd = headers.windowEnd;
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      // Out of quota before any details. Everything committed so far stands.
      status = 'quota';
      windowStart = plans[0]?.start ?? null;
    }

    // ---------------------------------------------------------- phase 2
    let newItemIds: number[] = [];
    if (status !== 'quota') {
      const details = await drainDetailQueue(options.detailBudget, {
        api: deps.api,
        db: deps.db,
        now: deps.now,
      });
      detailsFetched = details.detailsFetched;
      itemsNew = details.itemsNew;
      newItemIds = details.newItemIds;
      if (details.quotaExhausted) status = 'quota';
      else if (details.failures > 0) status = 'partial';
    }

    // ---------------------------------------------------------- phase 3
    // Categorization runs even after a quota stop: it is local work on rows
    // that already exist, and leaving them NULL for a day helps nobody.
    const fresh = await getCategorizableItems(deps.db, newItemIds);
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
    if (categorize.llmError && status === 'ok') status = 'partial';

    if (status === 'ok') await markSyncSuccess(deps.db, carrier.id, deps.now());
  } catch (err) {
    status = 'error';
    // Whatever this message is, the client scrubbed credentials out of it
    // before it got here — nothing carrying a card number reaches this row.
    error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  }

  await finishSyncRun(deps.db, runId, {
    status,
    finishedAt: deps.now(),
    windowStart,
    windowEnd,
    headersSeen,
    headersNew,
    detailsFetched,
    itemsNew,
    llmCalls: categorize.llmCalls,
    llmItems: categorize.llmItems,
    cacheHits: categorize.cacheHits,
    error,
  });

  const row = await getSyncRun(deps.db, runId);
  if (!row) throw new Error(`sync_run ${runId} vanished mid-run`);
  return row;
}
