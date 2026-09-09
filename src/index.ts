/**
 * The two entry points. One Worker script:
 *
 *   `scheduled()` — the cron trigger. It no longer fetches anything, because
 *                   there is nothing left to fetch: the MOF closed its API to
 *                   individuals and the export portal sits behind bot
 *                   management. What it does instead is watch for staleness
 *                   and say so, which is the honest version of "runs without
 *                   me" — it remembers so you do not have to.
 *   `fetch()`     — `/api/*` plus the static dashboard.
 *
 * Invoice data arrives through `POST /api/import`, from the dashboard's
 * upload or from the local watch-folder script. See docs/IMPORT.md.
 */
import { checkPrizes } from './prizes/check.js';
import {
  getCarrierByCardNo,
  getSyncState,
  insertCarrier,
  listSyncRuns,
} from './db/queries.js';
import { CLASSIFIER_MODEL } from './categorize/llm.js';
import { loadConfig, requireAuthSecrets } from './lib/config.js';
import { isIsoDate, isoToUnix, toIsoDate } from './lib/dates.js';
import type { ClassifyOptions } from './categorize/llm.js';
import {
  clearCookie,
  createSession,
  readSessionCookie,
  requireOwner,
  sessionCookie,
  verifyPassword,
  verifySession,
} from './api/auth.js';
import { handleImport, hasImportToken } from './api/import.js';
import {
  handleCreateOverride,
  handleDeleteOverride,
  handleListCategories,
  handleListOverrides,
  readBody,
} from './api/categorize.js';
import { handleInvoiceDetail, handleInvoiceList } from './api/invoices.js';
import { handleItems } from './api/items.js';
import { handlePrizes } from './api/prizes.js';
import { handleStats } from './api/stats.js';
import { handleSummary } from './api/summary.js';
import { handleImportStatus } from './api/status.js';
import { ApiError, errorResponse, json } from './api/respond.js';
import type { Env } from './types.js';

/** Data older than this is stale enough to be worth a nudge. */
const STALE_AFTER_DAYS = 10;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // Everything else is the dashboard bundle.
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('not found', { status: 404 });
    }
    try {
      return await route(request, env, url, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cronRun(env));
  },
};

async function route(
  request: Request,
  env: Env,
  url: URL,
  _ctx: ExecutionContext,
): Promise<Response> {
  const now = unixNow();
  const today = toIsoDate(now);
  const path = url.pathname;

  // ------------------------------------------------------------------ auth
  if (path === '/api/login' && request.method === 'POST') {
    requireAuthSecrets(env);
    const body = (await readBody(request)) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!(await verifyPassword(password, env.OWNER_PASSWORD_HASH))) {
      throw new ApiError(401, 'bad_credentials', 'wrong password');
    }
    const token = await createSession(env.SESSION_SECRET, now);
    return json({ ok: true }, 200, {
      'set-cookie': sessionCookie(token, url.protocol === 'https:'),
    });
  }

  if (path === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  if (path === '/api/session' && request.method === 'GET') {
    const ok = await verifySession(env.SESSION_SECRET, readSessionCookie(request), now);
    return json({ authenticated: ok });
  }

  // Import is the one route a machine can authenticate to: the watch-folder
  // script carries a bearer token rather than a session cookie. It still
  // falls back to the owner session, which is how a file dragged into the
  // dashboard arrives.
  if (path === '/api/import' && request.method === 'POST') {
    if (!hasImportToken(request, env)) await requireOwner(request, env, now);
    await ensureCarrier(env, now);
    // A real advancing clock, not the request's fixed `now`: newness is
    // inferred from `first_seen_at == now`, and a frozen clock would make
    // every re-imported row look new.
    return handleImport(request, env, { now: unixNow, llm: buildLlm(env) }, now);
  }

  // Everything past this point is the owner's.
  await requireOwner(request, env, now);

  // ------------------------------------------------------------------ read
  if (path === '/api/summary') return handleSummary(env.DB, url, today);
  if (path === '/api/invoices') return handleInvoiceList(env.DB, url);
  if (path.startsWith('/api/invoices/')) {
    return handleInvoiceDetail(env.DB, decodeURIComponent(path.slice('/api/invoices/'.length)));
  }
  if (path === '/api/items') return handleItems(env.DB, url);
  if (path === '/api/categories') return handleListCategories(env.DB);
  if (path === '/api/overrides') return handleListOverrides(env.DB);
  if (path === '/api/prizes') return handlePrizes(env.DB, url, today);

  if (path === '/api/stats' || path === '/api/import/status') {
    const carrier = await getCarrierByCardNo(env.DB, env.EINVOICE_CARD_NO ?? '');
    const carrierId = carrier?.id ?? 0;
    return path === '/api/stats'
      ? handleStats(env.DB, carrierId)
      : handleImportStatus(env.DB, carrierId, now, STALE_AFTER_DAYS);
  }

  // ----------------------------------------------------------------- write
  if (path === '/api/categorize') {
    if (request.method === 'POST') return handleCreateOverride(env.DB, env.CACHE, request, now);
    if (request.method === 'DELETE') return handleDeleteOverride(env.DB, env.CACHE, request);
  }

  throw new ApiError(404, 'not_found', `no route for ${request.method} ${path}`);
}

// --------------------------------------------------------------------- cron

/**
 * The watchdog. There is no data source to poll, so the job checks how old
 * the data is and notifies when it has gone stale, then re-checks prizes in
 * case winning numbers were recorded since the last run.
 *
 * Without this, the failure mode of a manual-import system is silence: you
 * simply stop importing and never notice the chart stopped moving.
 */
async function cronRun(env: Env): Promise<void> {
  const now = unixNow();
  const carrier = await getCarrierByCardNo(env.DB, env.EINVOICE_CARD_NO ?? '');
  if (!carrier) {
    console.warn('no carrier row yet — import once to create it');
    return;
  }

  const state = await getSyncState(env.DB, carrier.id);
  const lastSuccess = state?.last_success_at ?? null;
  const ageDays =
    lastSuccess === null ? Infinity : Math.floor((now - lastSuccess) / 86400);

  if (ageDays >= STALE_AFTER_DAYS) {
    await notify(
      env,
      lastSuccess === null
        ? 'Invoice Gang has never imported anything — export your carrier CSV and upload it.'
        : `Invoice data is ${ageDays} days old. Export a fresh carrier CSV and upload it.`,
    );
  }

  const runs = await listSyncRuns(env.DB, 1);
  console.log('staleness check', {
    synced_through: state?.synced_through ?? null,
    age_days: ageDays === Infinity ? null : ageDays,
    last_run_status: runs[0]?.status ?? null,
  });

  // Cheap, and it costs nothing when no numbers have been recorded.
  try {
    const prizes = await checkPrizes({
      db: env.DB,
      now: unixNow,
      notify: (message) => notify(env, message),
    });
    if (prizes.hits > 0) console.log(`prize check ${prizes.invPeriod}: ${prizes.hits} hit(s)`);
  } catch (err) {
    // A prize check failing must never take the staleness check with it.
    console.error('prize check failed', err);
  }
}

/**
 * Notification is a webhook so the channel is the owner's choice — ntfy,
 * Discord, Slack, whatever accepts a POST. Unset means log only, which is
 * still visible in `wrangler tail`.
 */
async function notify(env: Env, message: string): Promise<void> {
  console.log(message);
  if (!env.NOTIFY_WEBHOOK) return;
  try {
    await fetch(env.NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: message,
    });
  } catch (err) {
    console.error('notification failed', err);
  }
}

// ------------------------------------------------------------------ wiring

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The model half of the categorization pipeline. No key means an import does
 * everything except step 5 of the cascade rather than failing —
 * categorization never blocks an import.
 */
function buildLlm(env: Env): ClassifyOptions | null {
  const config = loadConfig(env);
  return env.ANTHROPIC_API_KEY
    ? { apiKey: env.ANTHROPIC_API_KEY, batchSize: config.llmBatchSize, model: CLASSIFIER_MODEL }
    : null;
}

/**
 * One carrier in v1, created on first use. `created_at` no longer decides how
 * much history is pulled — the export decides that — so it is only a record
 * of when the carrier was first seen.
 */
async function ensureCarrier(env: Env, now: number): Promise<void> {
  const cardNo = env.EINVOICE_CARD_NO ?? 'default';
  const existing = await getCarrierByCardNo(env.DB, cardNo);
  if (existing) return;

  const since = env.EINVOICE_CARRIER_SINCE;
  const createdAt = isIsoDate(since ?? '') ? isoToUnix(since as string) : now;

  await insertCarrier(env.DB, {
    cardType: '3J0002',
    cardNo,
    label: 'owner',
    createdAt,
  });
}
