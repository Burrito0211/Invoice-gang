/**
 * `GET /api/import/status` — the "is this actually still working" page.
 *
 * It replaces `/api/sync/status`, and it matters more than it did when a cron
 * fetched the data. The failure mode of a manual-import system is silence:
 * you stop importing, nothing errors, and the chart quietly stops moving. So
 * the freshness of the data is the headline, not a footnote.
 */
import { getSyncState, listSyncRuns } from '../db/queries.js';
import { json } from './respond.js';
import type { Unix } from '../types.js';

export async function handleImportStatus(
  db: D1Database,
  carrierId: number,
  now: Unix,
  staleAfterDays: number,
): Promise<Response> {
  const [runs, state] = await Promise.all([listSyncRuns(db, 20), getSyncState(db, carrierId)]);

  // Must be the actual current time, not midnight of today's date: an import
  // that ran an hour ago is younger than midnight and would age negatively.
  const lastSuccess = state?.last_success_at ?? null;
  const ageDays = lastSuccess === null ? null : Math.max(0, Math.floor((now - lastSuccess) / 86400));

  return json({
    // The last invoice date the imports have covered, not the last time one ran.
    covered_through: state?.synced_through ?? null,
    last_import_at: state?.last_run_at ?? null,
    last_success_at: lastSuccess,
    age_days: ageDays,
    stale_after_days: staleAfterDays,
    stale: ageDays === null || ageDays >= staleAfterDays,
    runs,
  });
}
