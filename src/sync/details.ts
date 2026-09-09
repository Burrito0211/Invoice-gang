/**
 * Phase 2 — the detail queue.
 *
 * Details come back one HTTP call per invoice against an unknown daily quota,
 * so they cannot be fetched inline with the headers. The queue is not a table;
 * it is the `detail_fetched_at IS NULL` query in db/queries.ts. Newest first,
 * because recent spending is what the dashboard is asked about and a long
 * backfill should not delay this month's data.
 *
 * Three outcomes per invoice, and the difference between them is the whole
 * correctness of this phase:
 *
 *   - rows returned → insert items, mark fetched
 *   - zero rows     → **do not** mark fetched. Details can lag behind headers,
 *                     and marking it complete would make the miss permanent.
 *                     Count the attempt; the cap stops a genuinely empty
 *                     invoice from being retried forever.
 *   - error         → count the attempt, store a scrubbed message, move on.
 *                     One bad invoice never aborts a run.
 *
 * A quota error is different in kind: it ends the phase immediately, keeps
 * everything already committed, and is not a failure.
 */
import {
  collectInsertedIds,
  insertItemStatement,
  markDetailFetched,
  recordDetailAttempt,
  selectPendingDetails,
} from '../db/queries.js';
import { itemKey } from '../categorize/normalize.js';
import { isQuotaError } from '../lib/errors.js';
import type { EInvoiceApi } from '../einvoice/client.js';
import type { Unix } from '../types.js';

/** Attempts after which an invoice leaves the queue for good. */
export const MAX_DETAIL_ATTEMPTS = 5;

export interface DetailPhaseResult {
  detailsFetched: number;
  itemsNew: number;
  /** Ids of the items this run created, handed straight to categorization. */
  newItemIds: number[];
  /** True when the phase stopped early on a quota error. */
  quotaExhausted: boolean;
  failures: number;
}

export interface DetailPhaseDeps {
  api: EInvoiceApi;
  db: D1Database;
  now: () => Unix;
}

export async function drainDetailQueue(
  budget: number,
  deps: DetailPhaseDeps,
): Promise<DetailPhaseResult> {
  const result: DetailPhaseResult = {
    detailsFetched: 0,
    itemsNew: 0,
    newItemIds: [],
    quotaExhausted: false,
    failures: 0,
  };
  if (budget <= 0) return result;

  const pending = await selectPendingDetails(deps.db, budget, MAX_DETAIL_ATTEMPTS);

  for (const invoice of pending) {
    try {
      const rows = await deps.api.carrierInvDetail({
        invNum: invoice.inv_num,
        invDate: invoice.inv_date,
        amount: invoice.amount,
        sellerName: invoice.seller_name,
        sellerBan: invoice.seller_ban,
      });

      if (rows.length === 0) {
        await recordDetailAttempt(
          deps.db,
          invoice.inv_num,
          'detail response contained no rows',
          deps.now(),
        );
        continue;
      }

      // INSERT OR IGNORE against UNIQUE (inv_num, row_num): re-fetching an
      // invoice is idempotent structurally, not by checking first.
      const statements = rows.map((row) =>
        insertItemStatement(deps.db, invoice.inv_num, row, itemKey(row.description)),
      );
      const batched = await deps.db.batch<{ id: number }>(statements);
      const ids = collectInsertedIds(batched);

      result.itemsNew += ids.length;
      result.newItemIds.push(...ids);

      await markDetailFetched(deps.db, invoice.inv_num, deps.now());
      result.detailsFetched += 1;
    } catch (err) {
      if (isQuotaError(err)) {
        // Not an error. Stop the phase, keep what landed, continue tomorrow.
        result.quotaExhausted = true;
        break;
      }
      // The client already scrubbed credentials out of this message.
      const message = err instanceof Error ? err.message : String(err);
      await recordDetailAttempt(deps.db, invoice.inv_num, message.slice(0, 500), deps.now());
      result.failures += 1;
    }
  }

  return result;
}
