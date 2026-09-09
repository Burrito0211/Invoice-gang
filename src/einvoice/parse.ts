/**
 * MOF response → domain types, tolerant of shape drift.
 *
 * Every field name in docs/EINVOICE-API.md is tagged [assumed]: they were
 * written from documentation knowledge, not from a successful call. So this
 * module never indexes a response object directly. It looks a field up by a
 * list of candidate spellings, case-insensitively, and tolerates the list
 * arriving under any of the plausible envelope keys. When Milestone 0 pins
 * the real names down, the surviving candidate can be moved to the front of
 * its list — nothing else has to change.
 *
 * This file is pure. It makes no HTTP calls and touches no database.
 */
import { EInvoiceError, QuotaError } from '../lib/errors.js';
import { fromApiDate } from '../lib/dates.js';
import type { InvoiceDetailRow, InvoiceHeader, PrizeClass, WinningNumbers } from '../types.js';

type Json = Record<string, unknown>;

/** The body's own status code. `200` means OK; an HTTP 200 does not. */
const OK_CODES = new Set(['200', '0']);

/**
 * Quota and rate-limit signals. [assumed] — the real codes are unknown, so
 * message matching is the fallback and the list is deliberately generous.
 * A false positive costs one deferred run; a false negative loses a run's
 * work to an exception, which is worse.
 */
const QUOTA_CODES = new Set(['904', '905', '919', '920', '429']);
const QUOTA_PATTERNS = [
  /次數/, // 查詢次數超過限制
  /上限/,
  /頻繁/,
  /超過限制/,
  /quota/i,
  /rate.?limit/i,
  /too many/i,
];

export function parseEnvelope(raw: unknown): Json {
  if (raw === null || typeof raw !== 'object') {
    throw new EInvoiceError('malformed', 'response body was not a JSON object');
  }
  const body = raw as Json;
  const code = String(pick(body, ['code', 'status', 'rtnCode']) ?? '');
  const msg = String(pick(body, ['msg', 'message', 'rtnMsg']) ?? '');

  if (code === '' || OK_CODES.has(code)) return body;
  if (QUOTA_CODES.has(code) || QUOTA_PATTERNS.some((p) => p.test(msg))) {
    throw new QuotaError(code, msg || 'quota exceeded');
  }
  throw new EInvoiceError(code, msg || `API returned code ${code}`);
}

export function parseHeaders(body: Json): InvoiceHeader[] {
  const rows = pickArray(body, ['details', 'invoices', 'data', 'result', 'list']);
  const headers: InvoiceHeader[] = [];

  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as Json;

    const invNum = str(pick(row, ['invNum', 'invoiceNumber', 'invoiceNo']));
    const rawDate = str(pick(row, ['invDate', 'invoiceDate']));
    if (!invNum || !rawDate) continue; // a row without an identity is not a row

    const invDate = fromApiDate(rawDate);
    if (!invDate) continue;

    headers.push({
      invNum: invNum.toUpperCase(),
      invDate,
      invPeriod: str(pick(row, ['invPeriod', 'invoicePeriod', 'invTerm'])),
      sellerBan: str(pick(row, ['sellerBan', 'sellerBanId', 'sellerId'])),
      sellerName: str(pick(row, ['sellerName', 'sellerCompanyName', 'storeName'])),
      amount: money(pick(row, ['amount', 'invAmount', 'totalAmount'])),
      invStatus: str(pick(row, ['invStatus', 'status', 'invoiceStatus'])),
      donatable: bool(pick(row, ['donatable', 'donateMark', 'canDonate'])),
    });
  }

  return headers;
}

export function parseDetails(body: Json): InvoiceDetailRow[] {
  const rows = pickArray(body, ['details', 'items', 'detail', 'data', 'result']);
  const out: InvoiceDetailRow[] = [];

  rows.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object') return;
    const row = raw as Json;

    const description = str(pick(row, ['description', 'itemName', 'productName', 'name']));
    if (!description) return; // an item with no description carries no information

    // rowNum is the idempotency key for items. If the API omits it, the
    // position in the returned array is the only stable substitute.
    const rowNum = intOr(pick(row, ['rowNum', 'rowNumber', 'seq', 'itemNo']), index + 1);

    out.push({
      rowNum,
      description,
      quantity: numberOrNull(pick(row, ['quantity', 'qty'])),
      unitPrice: moneyOrNull(pick(row, ['unitPrice', 'price'])),
      amount: money(pick(row, ['amount', 'lineAmount', 'subTotal', 'totalAmount'])),
    });
  });

  return out;
}

/**
 * The winning-number list. The API returns one field per prize class rather
 * than an array, and several classes publish more than one number, so the
 * numbered-field variants are all probed and de-duplicated afterwards.
 */
export function parseWinningNumbers(body: Json, invPeriod: string): WinningNumbers {
  const period = str(pick(body, ['invoYm', 'invPeriod', 'invTerm'])) ?? invPeriod;
  const numbers: { prizeClass: PrizeClass; number: string }[] = [];

  const add = (prizeClass: PrizeClass, value: unknown) => {
    for (const n of splitNumbers(value)) numbers.push({ prizeClass, number: n });
  };

  add('special', pick(body, ['superPrizeNo', 'specialPrizeNo', 'superPrize']));
  add('grand', pick(body, ['spcPrizeNo', 'grandPrizeNo', 'spcPrize']));
  add('grand', pick(body, ['spcPrizeNo2']));
  add('grand', pick(body, ['spcPrizeNo3']));
  add('first', pick(body, ['firstPrizeNo1', 'firstPrizeNo', 'firstPrize']));
  add('first', pick(body, ['firstPrizeNo2']));
  add('first', pick(body, ['firstPrizeNo3']));
  add('additional', pick(body, ['sixthPrizeNo1', 'addPrizeNo', 'sixthPrizeNo']));
  add('additional', pick(body, ['sixthPrizeNo2']));
  add('additional', pick(body, ['sixthPrizeNo3']));

  const seen = new Set<string>();
  const unique = numbers.filter((n) => {
    const id = `${n.prizeClass}:${n.number}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return { invPeriod: period, numbers: unique };
}

// ------------------------------------------------------------- field access

function pick(obj: Json, names: string[]): unknown {
  for (const name of names) {
    const v = obj[name];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  // Case-insensitive second pass, because the API is not consistent about it.
  const lowered = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) lowered.set(k.toLowerCase(), v);
  for (const name of names) {
    const v = lowered.get(name.toLowerCase());
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function pickArray(body: Json, names: string[]): unknown[] {
  const value = pick(body, names);
  if (Array.isArray(value)) return value;
  // Some actions return the list at the top level rather than under a key.
  for (const v of Object.values(body)) if (Array.isArray(v)) return v;
  return [];
}

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * Money is INTEGER everywhere. The API sends amounts as strings, sometimes
 * with a decimal tail (`"120.00"`), so round at the boundary and never let a
 * float past this function.
 */
function money(value: unknown): number {
  const n = numberOrNull(value);
  return n === null ? 0 : Math.round(n);
}

function moneyOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n === null ? null : Math.round(n);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function intOr(value: unknown, fallback: number): number {
  const n = numberOrNull(value);
  return n === null ? fallback : Math.trunc(n);
}

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return /^(y|yes|true|1)$/i.test(value.trim());
  return false;
}

function splitNumbers(value: unknown): string[] {
  const s = str(value);
  if (!s) return [];
  return s
    .split(/[\s,、;]+/)
    .map((n) => n.replace(/\D/g, ''))
    .filter((n) => n.length >= 3);
}
