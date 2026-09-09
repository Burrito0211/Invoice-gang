/**
 * Phase 1 — headers.
 *
 * The window calculation and the header upsert. Both halves of the
 * resumability invariant live here: the watermark advances only after the
 * headers for a chunk are committed, never before the call that produced
 * them, and the upsert leaves `detail_fetched_at` and `first_seen_at` alone.
 *
 * This module never makes an HTTP call itself — it takes the client as a
 * parameter, which is what makes the whole thing testable without a network.
 */
import { countNewHeaders, setWatermark, upsertInvoiceHeaderStatement } from '../db/queries.js';
import { addDays, minDate } from '../lib/dates.js';
import type { EInvoiceApi } from '../einvoice/client.js';
import type { IsoDate, Unix } from '../types.js';

export interface WindowPlan {
  start: IsoDate;
  end: IsoDate;
}

export interface PlanOptions {
  syncedThrough: IsoDate | null;
  carrierCreatedAt: IsoDate;
  today: IsoDate;
  overlapDays: number;
  windowDays: number;
  /** Hard cap on header calls per run — the bounded invariant. */
  callBudget: number;
}

/**
 * Chunk the outstanding date range into header calls.
 *
 *   start = (synced_through ?? carrier.created_at) − overlap
 *   end   = min(start + window, today)
 *
 * **The overlap re-scan is the whole trick.** Every run re-reads the last
 * `SYNC_OVERLAP_DAYS` of already-synced dates, so an invoice a merchant filed
 * late — after that date was already synced — is picked up on the next run
 * instead of being skipped permanently and silently. Already-known invoices
 * collide on the primary key and update harmlessly.
 *
 * The call budget is what keeps a year-long backfill many small runs rather
 * than one large one.
 */
export function planWindows(options: PlanOptions): WindowPlan[] {
  const { today, overlapDays, windowDays, callBudget } = options;
  const anchor = options.syncedThrough ?? options.carrierCreatedAt;

  let cursor = addDays(anchor, -overlapDays);
  if (cursor > today) cursor = today; // a watermark ahead of today re-reads today

  const plans: WindowPlan[] = [];
  while (plans.length < callBudget && cursor <= today) {
    const end = minDate(addDays(cursor, windowDays), today);
    plans.push({ start: cursor, end });
    if (end >= today) break;
    cursor = addDays(end, 1);
  }
  return plans;
}

export interface HeaderPhaseResult {
  headersSeen: number;
  headersNew: number;
  windowStart: IsoDate | null;
  windowEnd: IsoDate | null;
}

export interface HeaderPhaseDeps {
  api: EInvoiceApi;
  db: D1Database;
  carrierId: number;
  now: () => Unix;
}

/**
 * Run the planned chunks. Each chunk is committed as one batch and only then
 * does its watermark advance — kill the run anywhere and the next one resumes
 * from the last chunk that actually landed.
 */
export async function syncHeaders(
  plans: WindowPlan[],
  deps: HeaderPhaseDeps,
): Promise<HeaderPhaseResult> {
  const result: HeaderPhaseResult = {
    headersSeen: 0,
    headersNew: 0,
    windowStart: plans[0]?.start ?? null,
    windowEnd: null,
  };

  for (const plan of plans) {
    const headers = await deps.api.carrierInvChk(plan);
    result.headersSeen += headers.length;

    if (headers.length > 0) {
      const now = deps.now();
      const statements = headers.map((h) =>
        upsertInvoiceHeaderStatement(deps.db, deps.carrierId, h, now),
      );
      const batched = await deps.db.batch<{ first_seen_at: Unix }>(statements);
      result.headersNew += countNewHeaders(batched, now);
    }

    // Only now. Advancing before the upsert would let a crash between the two
    // skip a window forever.
    await setWatermark(deps.db, deps.carrierId, plan.end, deps.now());
    result.windowEnd = plan.end;
  }

  return result;
}
