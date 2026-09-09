/**
 * The two entry points. One Worker script:
 *
 *   `scheduled()` — the cron trigger. The "runs without me" requirement, and
 *                   the single feature that separates this project from a
 *                   client-side toy.
 *   `fetch()`     — `/api/*` plus the static dashboard.
 *
 * They share every module. The sync can also be invoked over HTTP by the
 * owner, which is what makes manual runs and local development the same code
 * path as the nightly job rather than a second one that rots.
 */
import { EInvoiceClient } from './einvoice/client.js';
import { checkPrizes } from './prizes/fetch.js';
import { runSync } from './sync/run.js';
import { getCarrierByCardNo, insertCarrier } from './db/queries.js';
import { CLASSIFIER_MODEL } from './categorize/llm.js';
import { loadConfig, requireAuthSecrets, requireSyncSecrets } from './lib/config.js';
import { isIsoDate, isoToUnix, toIsoDate } from './lib/dates.js';
import {
  clearCookie,
  createSession,
  readSessionCookie,
  requireOwner,
  sessionCookie,
  verifyPassword,
  verifySession,
} from './api/auth.js';
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
import { handleSyncStatus, handleSyncTrigger } from './api/sync.js';
import { ApiError, errorResponse, json } from './api/respond.js';
import type { Env } from './types.js';
import type { RunSyncDeps } from './sync/run.js';

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
  const now = Math.floor(Date.now() / 1000);
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
    return json(
      { ok: true },
      200,
      { 'set-cookie': sessionCookie(token, url.protocol === 'https:') },
    );
  }

  if (path === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  if (path === '/api/session' && request.method === 'GET') {
    const ok = await verifySession(env.SESSION_SECRET, readSessionCookie(request), now);
    return json({ authenticated: ok });
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

  if (path === '/api/stats' || path === '/api/sync/status') {
    const carrier = await getCarrierByCardNo(env.DB, env.EINVOICE_CARD_NO ?? '');
    const carrierId = carrier?.id ?? 0;
    return path === '/api/stats'
      ? handleStats(env.DB, carrierId)
      : handleSyncStatus(env.DB, carrierId);
  }

  // ----------------------------------------------------------------- write
  if (path === '/api/categorize') {
    if (request.method === 'POST') return handleCreateOverride(env.DB, env.CACHE, request, now);
    if (request.method === 'DELETE') return handleDeleteOverride(env.DB, env.CACHE, request);
  }

  if (path === '/api/sync' && request.method === 'POST') {
    requireSyncSecrets(env);
    const config = loadConfig(env);
    await ensureCarrier(env, now);
    return handleSyncTrigger(
      request,
      buildSyncDeps(env),
      {
        cardNo: env.EINVOICE_CARD_NO,
        overlapDays: config.overlapDays,
        windowDays: config.windowDays,
        headerCallBudget: config.headerCallBudget,
        detailBudget: config.detailBudgetPerRun,
      },
      now,
    );
  }

  throw new ApiError(404, 'not_found', `no route for ${request.method} ${path}`);
}

// --------------------------------------------------------------------- cron

async function cronRun(env: Env): Promise<void> {
  // Validate before the first HTTP call: a nightly job that runs with a
  // missing secret does not fail, it silently syncs nothing.
  requireSyncSecrets(env);
  const config = loadConfig(env);
  const now = Math.floor(Date.now() / 1000);
  await ensureCarrier(env, now);

  const deps = buildSyncDeps(env);
  const run = await runSync(deps, {
    trigger: 'cron',
    cardNo: env.EINVOICE_CARD_NO,
    overlapDays: config.overlapDays,
    windowDays: config.windowDays,
    headerCallBudget: config.headerCallBudget,
    detailBudget: config.detailBudgetPerRun,
  });
  console.log(`sync run ${run.id}: ${run.status}`, {
    headers_new: run.headers_new,
    details_fetched: run.details_fetched,
    items_new: run.items_new,
    llm_calls: run.llm_calls,
    cache_hits: run.cache_hits,
  });

  // Prizes are cheap and only worth doing occasionally — the numbers change
  // six times a year, and `checkPrizes` no-ops once the period is cached.
  try {
    const prizes = await checkPrizes({
      api: deps.api,
      db: env.DB,
      now: deps.now,
      notify: (message) => {
        console.log(message);
        return Promise.resolve();
      },
    });
    if (prizes.hits > 0) console.log(`prize check ${prizes.invPeriod}: ${prizes.hits} hit(s)`);
  } catch (err) {
    // A prize check failing must never take the sync's result with it.
    console.error('prize check failed', err);
  }
}

// ------------------------------------------------------------------ wiring

function buildSyncDeps(env: Env): RunSyncDeps {
  const config = loadConfig(env);
  return {
    api: new EInvoiceClient({
      baseUrl: config.baseUrl,
      appId: env.EINVOICE_APP_ID,
      uuid: config.uuid,
      credentials: {
        cardType: '3J0002',
        cardNo: env.EINVOICE_CARD_NO,
        cardEncrypt: env.EINVOICE_CARD_ENCRYPT,
      },
    }),
    db: env.DB,
    kv: env.CACHE,
    now: () => Math.floor(Date.now() / 1000),
    // No key means the run does everything except step 5 of the cascade,
    // rather than failing. Categorization never blocks the sync.
    llm: env.ANTHROPIC_API_KEY
      ? {
          apiKey: env.ANTHROPIC_API_KEY,
          batchSize: config.llmBatchSize,
          model: CLASSIFIER_MODEL,
        }
      : null,
  };
}

/**
 * One carrier in v1, created on first use from the configured secret.
 *
 * `created_at` is where the very first sync window starts, so it decides how
 * much history gets pulled. It defaults to today — set `EINVOICE_CARRIER_SINCE`
 * to backfill instead, and let the run budget spread it over several nights.
 */
async function ensureCarrier(env: Env, now: number): Promise<void> {
  const existing = await getCarrierByCardNo(env.DB, env.EINVOICE_CARD_NO);
  if (existing) return;

  const since = env.EINVOICE_CARRIER_SINCE;
  const createdAt = isIsoDate(since ?? '') ? isoToUnix(since as string) : now;

  await insertCarrier(env.DB, {
    cardType: '3J0002',
    cardNo: env.EINVOICE_CARD_NO,
    label: 'owner',
    createdAt,
  });
}
