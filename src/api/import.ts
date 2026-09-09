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
import { findRunningSyncRun, getCarrierByCardNo } from '../db/queries.js';
import { importCarrierCsv, type ImportDeps } from '../import/run.js';
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

export async function handleImport(
  request: Request,
  env: Env,
  deps: Omit<ImportDeps, 'db' | 'kv'>,
  now: Unix,
): Promise<Response> {
  const carrier = await getCarrierByCardNo(env.DB, env.EINVOICE_CARD_NO ?? '');
  if (!carrier) {
    throw new ApiError(
      409,
      'no_carrier',
      'no carrier row — set EINVOICE_CARD_NO and import once to create it',
    );
  }

  const inflight = await findRunningSyncRun(env.DB, now - CONCURRENT_RUN_SECONDS);
  if (inflight) {
    throw new ApiError(409, 'import_in_progress', `run ${inflight.id} is still running`);
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) {
    throw new ApiError(413, 'too_large', `file exceeds ${MAX_BYTES} bytes`);
  }

  const csv = await request.text();
  if (csv.trim() === '') throw new ApiError(400, 'empty', 'request body was empty');
  if (csv.length > MAX_BYTES) throw new ApiError(413, 'too_large', 'file too large');

  const url = new URL(request.url);
  const trigger: SyncTrigger = url.searchParams.get('trigger') === 'backfill' ? 'backfill' : 'manual';

  const result = await importCarrierCsv(
    csv,
    { db: env.DB, kv: env.CACHE, now: deps.now, llm: deps.llm },
    { carrierId: carrier.id, trigger },
  );

  // A parse failure is reported as a failed run rather than thrown, so the
  // caller gets the reason and the attempt is still recorded in sync_run.
  const status = result.run.status === 'error' ? 422 : 200;

  return json(
    {
      run: result.run,
      invoices_seen: result.invoicesSeen,
      // Voided and donated invoices arrive with digits masked; surfaced so a
      // gap in the totals is visible rather than silent.
      masked_invoice_numbers: result.masked,
      skipped_rows: result.skipped,
    },
    status,
  );
}

/** Constant-time compare so the token cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
