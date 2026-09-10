/**
 * `/api/income` and `/api/items/exclude`.
 *
 * Income is the one figure in this system typed by hand rather than derived
 * from an invoice — deliberately kept in its own table and its own handler,
 * beside the invoice pipeline rather than inside it. Money is an INTEGER of
 * New Taiwan dollars here as everywhere.
 */
import {
  deleteIncome,
  insertIncome,
  listIncome,
  setItemExcluded,
} from '../db/queries.js';
import { ApiError, badRequest, dateRange, json } from './respond.js';
import { readBody } from './categorize.js';
import type { IsoDate, Unix } from '../types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleListIncome(db: D1Database, url: URL, today: IsoDate): Promise<Response> {
  const { from, to } = dateRange(url, today);
  return json({ income: await listIncome(db, from, to) });
}

export async function handleCreateIncome(
  db: D1Database,
  request: Request,
  now: Unix,
): Promise<Response> {
  const body = (await readBody(request)) as {
    date?: unknown;
    amount?: unknown;
    source?: unknown;
    note?: unknown;
  };

  const date = typeof body.date === 'string' ? body.date : '';
  if (!ISO_DATE.test(date)) throw badRequest('date must be YYYY-MM-DD');

  // Integers only — no float ever touches an amount, and income is positive.
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw badRequest('amount must be a positive integer of NT$');
  }

  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (source === '') throw badRequest('source is required, e.g. 薪資');

  const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null;

  const id = await insertIncome(db, { date, amount, source, note, now });
  return json({ id, date, amount, source, note }, 201);
}

export async function handleDeleteIncome(db: D1Database, idText: string): Promise<Response> {
  const id = Number(idText);
  if (!Number.isInteger(id)) throw badRequest('id must be an integer');
  const removed = await deleteIncome(db, id);
  if (!removed) throw new ApiError(404, 'not_found', `no income row ${id}`);
  return json({ ok: true });
}

/**
 * `POST /api/items/exclude { id, mine }` — mark a line item as the owner's
 * spending or not. Phrased as `mine` because that is the question the UI asks;
 * the column it maps to is `excluded`.
 */
export async function handleItemExclude(
  db: D1Database,
  request: Request,
): Promise<Response> {
  const body = (await readBody(request)) as { id?: unknown; mine?: unknown };
  const id = Number(body.id);
  if (!Number.isInteger(id)) throw badRequest('id must be an integer');
  if (typeof body.mine !== 'boolean') throw badRequest('mine must be true or false');

  const changed = await setItemExcluded(db, id, !body.mine);
  if (!changed) throw new ApiError(404, 'not_found', `no item ${id}`);
  return json({ id, mine: body.mine });
}
