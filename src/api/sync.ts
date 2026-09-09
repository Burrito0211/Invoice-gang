/**
 * `POST /api/sync` and `GET /api/sync/status`.
 *
 * The manual run is the same code path as the cron — different config, no
 * special backfill mode. A backfill is this endpoint with a longer window and
 * a bigger detail budget.
 *
 * The status route is the "is it actually still working" page, and it matters
 * more than it looks: without it every failure of an unattended nightly job is
 * silent.
 */
import { findRunningSyncRun, getSyncState, listSyncRuns } from '../db/queries.js';
import { runSync } from '../sync/run.js';
import { ApiError, json } from './respond.js';
import { readBody } from './categorize.js';
import type { RunSyncDeps } from '../sync/run.js';
import type { SyncTrigger, Unix } from '../types.js';

/** A run that started within this window and never finished is still running. */
const CONCURRENT_RUN_SECONDS = 600;

interface SyncBody {
  trigger?: unknown;
  window_days?: unknown;
  detail_budget?: unknown;
}

export async function handleSyncTrigger(
  request: Request,
  deps: RunSyncDeps,
  defaults: {
    cardNo: string;
    overlapDays: number;
    windowDays: number;
    headerCallBudget: number;
    detailBudget: number;
  },
  now: Unix,
): Promise<Response> {
  const inflight = await findRunningSyncRun(deps.db, now - CONCURRENT_RUN_SECONDS);
  if (inflight) {
    // 409 rather than racing: two concurrent syncs double the quota burn and
    // produce no data the single run would not have produced anyway.
    throw new ApiError(409, 'sync_in_progress', `run ${inflight.id} is still running`);
  }

  const body = (await readBody(request).catch(() => ({}))) as SyncBody;
  const trigger: SyncTrigger = body.trigger === 'backfill' ? 'backfill' : 'manual';

  const run = await runSync(deps, {
    trigger,
    cardNo: defaults.cardNo,
    overlapDays: defaults.overlapDays,
    windowDays: positiveInt(body.window_days) ?? defaults.windowDays,
    headerCallBudget: defaults.headerCallBudget,
    detailBudget: positiveInt(body.detail_budget) ?? defaults.detailBudget,
  });

  return json({ run });
}

export async function handleSyncStatus(db: D1Database, carrierId: number): Promise<Response> {
  const [runs, state] = await Promise.all([listSyncRuns(db, 20), getSyncState(db, carrierId)]);
  return json({
    watermark: state?.synced_through ?? null,
    last_run_at: state?.last_run_at ?? null,
    last_success_at: state?.last_success_at ?? null,
    runs,
  });
}

function positiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
