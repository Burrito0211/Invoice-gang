/**
 * Watch a folder for carrier CSV exports and upload them.
 *
 *   node scripts/watch-folder.mjs
 *
 * This is what replaced the crawler. The portal sits behind bot management,
 * so nothing automated can log in for you — but everything *after* the
 * download can be automatic, which is where all the actual work is anyway.
 *
 * Your part: log in, click export. This picks the file up from your Downloads
 * folder within seconds, posts it to `/api/import`, and moves it to an
 * archive folder so it is not uploaded twice. Parsing, de-duplication,
 * categorization and the dashboard update happen on the other side.
 *
 * Re-uploading the same export is harmless anyway — the importer is
 * idempotent by construction — so the archive step is tidiness, not safety.
 *
 * Configure with a .env-style file or environment variables:
 *
 *   INVOICE_GANG_URL=https://invoice-gang.<subdomain>.workers.dev
 *   INVOICE_GANG_TOKEN=<the IMPORT_TOKEN secret>
 *   INVOICE_GANG_WATCH=C:\Users\you\Downloads      (optional)
 *   INVOICE_GANG_ARCHIVE=C:\Users\you\Downloads\invoice-gang-archive
 *
 * Run it from Task Scheduler at logon, or by hand when you have exported.
 * `--once` processes whatever is already there and exits, which is the mode
 * to use for a scheduled task.
 */
import { readdir, readFile, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG = {
  url: process.env.INVOICE_GANG_URL ?? '',
  token: process.env.INVOICE_GANG_TOKEN ?? '',
  watchDir: process.env.INVOICE_GANG_WATCH ?? join(homedir(), 'Downloads'),
  archiveDir:
    process.env.INVOICE_GANG_ARCHIVE ?? join(homedir(), 'Downloads', 'invoice-gang-archive'),
  intervalMs: Number(process.env.INVOICE_GANG_INTERVAL_MS ?? 30_000),
};

const ONCE = process.argv.includes('--once');

/**
 * The export is named like `6943298_20260909112909.csv` — an account number
 * and a timestamp. Matching the shape rather than any .csv avoids uploading
 * unrelated spreadsheets that happen to be in Downloads.
 */
const EXPORT_NAME = /^\d{5,}_\d{14}\.csv$/i;

/** The header row every carrier export starts with, after the BOM. */
const EXPECTED_FIRST_COLUMN = '載具自訂名稱';

function fail(message) {
  console.error(`invoice-gang: ${message}`);
  process.exit(1);
}

if (!CONFIG.url) fail('set INVOICE_GANG_URL to your deployed Worker URL');
if (!CONFIG.token) fail('set INVOICE_GANG_TOKEN to the IMPORT_TOKEN secret you configured');

async function looksLikeExport(path) {
  // Cheap structural check before uploading. A file that is not a carrier
  // export would be rejected server-side anyway, but failing here keeps the
  // sync_run table free of junk attempts.
  const head = (await readFile(path, 'utf8')).slice(0, 400).replace(/^\uFEFF/, '');
  return head.startsWith(EXPECTED_FIRST_COLUMN);
}

/**
 * A file that appeared a moment ago may still be downloading. Uploading a
 * half-written CSV would import a truncated month, so wait for the size to
 * stop changing before touching it.
 */
async function isSettled(path) {
  const first = await stat(path);
  await new Promise((r) => setTimeout(r, 1500));
  const second = await stat(path);
  return first.size === second.size && second.size > 0;
}

async function upload(path, name) {
  const csv = await readFile(path, 'utf8');
  const response = await fetch(new URL('/api/import', CONFIG.url), {
    method: 'POST',
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      authorization: `Bearer ${CONFIG.token}`,
    },
    body: csv,
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    console.error(`invoice-gang: ${name} rejected — ${message}`);
    return false;
  }

  const run = body.run ?? {};
  console.log(
    `invoice-gang: ${name} → ${body.invoices_seen} invoices, ` +
      `${run.headers_new} new, ${run.items_new} items, ` +
      `${run.llm_calls} model call(s), status ${run.status}`,
  );
  if (body.masked_invoice_numbers?.length) {
    console.warn(`  masked invoice numbers: ${body.masked_invoice_numbers.join(', ')}`);
  }
  for (const row of body.skipped_rows ?? []) {
    console.warn(`  skipped line ${row.line}: ${row.reason}`);
  }
  return true;
}

async function archive(path, name) {
  await mkdir(CONFIG.archiveDir, { recursive: true });
  let target = join(CONFIG.archiveDir, name);
  if (existsSync(target)) target = join(CONFIG.archiveDir, `${Date.now()}-${name}`);
  await rename(path, target);
}

async function sweep() {
  let entries;
  try {
    entries = await readdir(CONFIG.watchDir);
  } catch (err) {
    console.error(`invoice-gang: cannot read ${CONFIG.watchDir} — ${err.message}`);
    return;
  }

  for (const name of entries.filter((n) => EXPORT_NAME.test(n))) {
    const path = join(CONFIG.watchDir, name);
    try {
      if (!(await isSettled(path))) continue; // still downloading
      if (!(await looksLikeExport(path))) continue; // not a carrier export
      if (await upload(path, name)) await archive(path, name);
    } catch (err) {
      // One bad file never stops the watcher.
      console.error(`invoice-gang: ${name} failed — ${err.message}`);
    }
  }
}

console.log(`invoice-gang: watching ${CONFIG.watchDir}`);
console.log(`invoice-gang: uploading to ${new URL('/api/import', CONFIG.url).href}`);

await sweep();
if (!ONCE) {
  setInterval(() => {
    void sweep();
  }, CONFIG.intervalMs);
}
