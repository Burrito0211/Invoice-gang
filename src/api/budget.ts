/**
 * `/api/budget` — the one figure in this system that points forwards.
 *
 * Everything else the API serves is a record of what happened. A budget is a
 * statement about what has not happened yet, and the gap between the two is
 * the only thing that turns the dashboard from a report into something you
 * can make a decision against.
 *
 * The arithmetic lives in `budget/pace.ts` and is pure; this handler does
 * nothing but validate, fetch the two numbers it needs, and hand them over.
 */
import { getEffectiveBudget, deleteBudget, totalsForRange, upsertBudget } from '../db/queries.js';
import { isMonth, monthRange, pace } from '../budget/pace.js';
import { badRequest, json } from './respond.js';
import { readBody } from './categorize.js';
import type { IsoDate, Unix } from '../types.js';

export async function handleGetBudget(
  db: D1Database,
  accountId: number,
  url: URL,
  today: IsoDate,
): Promise<Response> {
  return json(await describe(db, accountId, monthParam(url, today), today));
}

/**
 * `PUT /api/budget { amount, month? }`. Writing to a month creates the change
 * point every later month inherits from, so setting it in September also
 * budgets October — see the table comment in the schema.
 */
export async function handleSetBudget(
  db: D1Database,
  accountId: number,
  request: Request,
  url: URL,
  today: IsoDate,
  now: Unix,
): Promise<Response> {
  const body = (await readBody(request)) as { amount?: unknown; month?: unknown };

  const month = body.month === undefined ? monthParam(url, today) : asMonth(body.month);
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw badRequest('amount must be a positive integer of NT$');
  }

  await upsertBudget(db, accountId, { month, amount, now });
  return json(await describe(db, accountId, month, today));
}

/**
 * Removing a month's row does not leave it unbudgeted — it falls back to the
 * row before it. This undoes a change rather than deleting the budget, which
 * is what makes it safe to offer beside an editable figure.
 */
export async function handleDeleteBudget(
  db: D1Database,
  accountId: number,
  url: URL,
  today: IsoDate,
): Promise<Response> {
  const month = monthParam(url, today);
  await deleteBudget(db, accountId, month);
  return json(await describe(db, accountId, month, today));
}

async function describe(db: D1Database, accountId: number, month: string, today: IsoDate) {
  const { from, to } = monthRange(month);
  const [row, totals] = await Promise.all([
    getEffectiveBudget(db, accountId, month),
    totalsForRange(db, accountId, from, to),
  ]);

  return {
    ...pace({
      month,
      amount: row?.amount ?? null,
      // Already net of discounts and of items marked not-mine, which is what
      // a budget should be judged against.
      spent: totals?.invoice_total ?? 0,
      today,
    }),
    // Which month's row supplied the figure. Different from `month` means it
    // was carried forward, and the UI says so rather than implying it was set
    // for this month deliberately.
    effective_from: row?.month ?? null,
  };
}

function monthParam(url: URL, today: IsoDate): string {
  const raw = url.searchParams.get('month');
  return raw === null || raw === '' ? today.slice(0, 7) : asMonth(raw);
}

function asMonth(value: unknown): string {
  if (!isMonth(value)) throw badRequest('month must be YYYY-MM');
  return value;
}
