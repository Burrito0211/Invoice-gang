/**
 * The two entry points. One Worker script:
 *
 *   `scheduled()` — the cron trigger. It no longer fetches anything, because
 *                   there is nothing left to fetch: the MOF closed its API to
 *                   individuals and the export portal sits behind bot
 *                   management. What it does instead is watch each account
 *                   that asked to be nudged for staleness and say so, which is
 *                   the honest version of "runs without me" — it remembers so
 *                   you do not have to.
 *   `fetch()`     — `/api/*` plus the static dashboard.
 *
 * Invoice data arrives through `POST /api/import`, from the dashboard's
 * upload or from the local watch-folder script. See docs/IMPORT.md.
 *
 * Every route past sign-in resolves the caller to an account id before
 * anything else happens, and hands that id to its handler, which hands it to
 * every query. There is no route that reads personal data without one.
 */
import { checkPrizes } from './prizes/check.js';
import { getAccountById, getCarrierForAccount, listNotifiableAccounts } from './db/queries.js';
import { CLASSIFIER_MODEL } from './categorize/llm.js';
import { loadConfig, requireAuthSecrets } from './lib/config.js';
import { toIsoDate } from './lib/dates.js';
import type { ClassifyOptions } from './categorize/llm.js';
import { clearCookie, readSessionCookie, requireAccount, verifySession } from './api/auth.js';
import {
  accountFromImportToken,
  handleAccount,
  handleCreateImportToken,
  handleDeleteImportToken,
  handleLogin,
  handleRegister,
  handleUpdateAccount,
} from './api/account.js';
import {
  handleDeleteBudget,
  handleGetBudget,
  handleSetBudget,
} from './api/budget.js';
import { handleImport, handleImportPreview } from './api/import.js';
import {
  handleCreateIncome,
  handleDeleteIncome,
  handleItemExclude,
  handleListIncome,
} from './api/income.js';
import {
  handleCreateOverride,
  handleDeleteOverride,
  handleListCategories,
  handleListOverrides,
} from './api/categorize.js';
import { handleInvoiceDetail, handleInvoiceList } from './api/invoices.js';
import { handleItems } from './api/items.js';
import { handlePrizes } from './api/prizes.js';
import { handleStats } from './api/stats.js';
import { handleSummary } from './api/summary.js';
import { handleImportStatus } from './api/status.js';
import { ApiError, errorResponse, json } from './api/respond.js';
import type { Env } from './types.js';

/**
 * Data older than this is stale enough to be worth a nudge.
 *
 * Five days, not ten. Ten was tuned for a dashboard you glance at; a budget
 * is something you make a decision against, and a decision made on ten-day-old
 * spending is made on the wrong number. Twice-weekly exports keep the data
 * two to four days old, so five days means exactly one missed export.
 */
const STALE_AFTER_DAYS = 5;

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
  const secure = url.protocol === 'https:';

  // ------------------------------------------------------------------ auth
  // Sign-up is open: anyone who reaches the site can make an account. What
  // keeps that safe is that an account can only ever reach its own rows.
  if (path === '/api/register' && request.method === 'POST') {
    requireAuthSecrets(env);
    return handleRegister(request, env, secure, now);
  }

  if (path === '/api/login' && request.method === 'POST') {
    requireAuthSecrets(env);
    return handleLogin(request, env, secure, now);
  }

  if (path === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  if (path === '/api/session' && request.method === 'GET') {
    const accountId = await verifySession(env.SESSION_SECRET, readSessionCookie(request), now);
    const account = accountId === null ? null : await getAccountById(env.DB, accountId);
    return json(
      account ? { authenticated: true, username: account.username } : { authenticated: false },
    );
  }

  // The preview is a dry run — it writes nothing — so it is session-only and
  // never opens to an import token, which exists purely for the headless
  // upload path that has no screen to preview onto.
  if (path === '/api/import/preview' && request.method === 'POST') {
    const accountId = await requireAccount(request, env, now);
    return handleImportPreview(request, env, accountId);
  }

  // Import is the one route a machine can authenticate to: the watch-folder
  // script carries its account's import token rather than a session cookie.
  // It still falls back to the session, which is how a file dragged into the
  // dashboard arrives.
  if (path === '/api/import' && request.method === 'POST') {
    const accountId =
      (await accountFromImportToken(request, env.DB, now)) ??
      (await requireAccount(request, env, now));
    // A real advancing clock, not the request's fixed `now`: newness is
    // inferred from `first_seen_at == now`, and a frozen clock would make
    // every re-imported row look new.
    return handleImport(request, env, accountId, { now: unixNow, llm: buildLlm(env) }, now);
  }

  // Everything past this point belongs to the signed-in account.
  const accountId = await requireAccount(request, env, now);

  // --------------------------------------------------------------- account
  if (path === '/api/account') {
    if (request.method === 'GET') return handleAccount(env.DB, accountId);
    if (request.method === 'PUT') return handleUpdateAccount(env.DB, accountId, request);
  }
  if (path === '/api/account/import-token') {
    if (request.method === 'POST') return handleCreateImportToken(env.DB, accountId, now);
    if (request.method === 'DELETE') return handleDeleteImportToken(env.DB, accountId);
  }

  // ------------------------------------------------------------------ read
  if (path === '/api/summary') return handleSummary(env.DB, accountId, url, today);
  if (path === '/api/invoices') return handleInvoiceList(env.DB, accountId, url);
  if (path.startsWith('/api/invoices/')) {
    return handleInvoiceDetail(
      env.DB,
      accountId,
      decodeURIComponent(path.slice('/api/invoices/'.length)),
    );
  }
  if (path === '/api/items') return handleItems(env.DB, accountId, url);
  if (path === '/api/categories') return handleListCategories(env.DB);
  if (path === '/api/overrides') return handleListOverrides(env.DB, accountId);
  if (path === '/api/prizes') return handlePrizes(env.DB, accountId, url, today);

  // The budget is monthly, so it is addressed by month rather than by the
  // dashboard's arbitrary from/to range. GET and PUT share a path because
  // they describe the same thing, and both answer with the full pacing view
  // so setting a figure immediately shows what it implies.
  if (path === '/api/budget') {
    if (request.method === 'GET') return handleGetBudget(env.DB, accountId, url, today);
    if (request.method === 'PUT') {
      return handleSetBudget(env.DB, accountId, request, url, today, now);
    }
    if (request.method === 'DELETE') return handleDeleteBudget(env.DB, accountId, url, today);
  }

  if (path === '/api/income') {
    if (request.method === 'GET') return handleListIncome(env.DB, accountId, url, today);
    if (request.method === 'POST') return handleCreateIncome(env.DB, accountId, request, now);
  }
  if (path.startsWith('/api/income/') && request.method === 'DELETE') {
    return handleDeleteIncome(env.DB, accountId, path.slice('/api/income/'.length));
  }
  if (path === '/api/items/exclude' && request.method === 'POST') {
    return handleItemExclude(env.DB, accountId, request);
  }

  if (path === '/api/stats' || path === '/api/import/status') {
    const carrier = await getCarrierForAccount(env.DB, accountId);
    const carrierId = carrier?.id ?? 0;
    return path === '/api/stats'
      ? handleStats(env.DB, accountId, carrierId)
      : handleImportStatus(env.DB, accountId, carrierId, now, STALE_AFTER_DAYS);
  }

  // ----------------------------------------------------------------- write
  if (path === '/api/categorize') {
    if (request.method === 'POST') return handleCreateOverride(env.DB, accountId, request, now);
    if (request.method === 'DELETE') return handleDeleteOverride(env.DB, accountId, request);
  }

  throw new ApiError(404, 'not_found', `no route for ${request.method} ${path}`);
}

// --------------------------------------------------------------------- cron

/**
 * The watchdog. There is no data source to poll, so the job checks how old
 * each account's data is and nudges the ones that have gone stale, then
 * re-checks prizes in case winning numbers were recorded since the last run.
 *
 * Without this, the failure mode of a manual-import system is silence: you
 * simply stop importing and never notice the chart stopped moving. An account
 * without a webhook still gets the dashboard banner.
 */
async function cronRun(env: Env): Promise<void> {
  const now = unixNow();
  const accounts = await listNotifiableAccounts(env.DB);

  let nudged = 0;
  for (const account of accounts) {
    const lastSuccess = account.last_success_at;
    const ageDays = lastSuccess === null ? Infinity : Math.floor((now - lastSuccess) / 86400);
    if (ageDays < STALE_AFTER_DAYS) continue;

    await notify(
      account.notify_webhook,
      lastSuccess === null
        ? 'Invoice Gang has never imported anything for you — export your carrier CSV and upload it.'
        : `Your invoice data is ${ageDays} days old. Export a fresh carrier CSV and upload it.`,
    );
    nudged += 1;
  }
  console.log('staleness check', { accounts_with_webhook: accounts.length, nudged });

  // Cheap, and it costs nothing when no numbers have been recorded.
  try {
    const prizes = await checkPrizes({ db: env.DB, now: unixNow, notify });
    if (prizes.hits > 0) console.log(`prize check ${prizes.invPeriod}: ${prizes.hits} hit(s)`);
  } catch (err) {
    // A prize check failing must never take the staleness check with it.
    console.error('prize check failed', err);
  }
}

/**
 * A plain-text POST to the webhook an account set — ntfy, Discord, Slack,
 * whatever accepts one. Each message goes only to the account it is about,
 * and is not logged: it names that account's invoices.
 */
async function notify(webhook: string, message: string): Promise<void> {
  try {
    await fetch(webhook, {
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
 *
 * Sign-up is open, so with a key set every account's imports can spend it.
 */
function buildLlm(env: Env): ClassifyOptions | null {
  const config = loadConfig(env);
  return env.ANTHROPIC_API_KEY
    ? { apiKey: env.ANTHROPIC_API_KEY, batchSize: config.llmBatchSize, model: CLASSIFIER_MODEL }
    : null;
}
