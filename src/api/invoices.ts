/**
 * `GET /api/invoices` and `GET /api/invoices/:invNum`.
 *
 * The list is keyset paginated on `(inv_date, inv_num)`. OFFSET degrades over
 * a long list and silently skips rows when new invoices land mid-scroll, which
 * for this data happens every night.
 */
import { getInvoice, getItemsForInvoice, listInvoices } from '../db/queries.js';
import { intParam, json, notFound, optionalDate, optionalString } from './respond.js';
import type { IsoDate } from '../types.js';

const MAX_LIMIT = 200;

export async function handleInvoiceList(db: D1Database, url: URL): Promise<Response> {
  const limit = intParam(url, 'limit', 50, MAX_LIMIT);
  const rows = await listInvoices(db, {
    from: optionalDate(url, 'from'),
    to: optionalDate(url, 'to'),
    categoryKey: optionalString(url, 'category'),
    q: optionalString(url, 'q'),
    cursor: decodeCursor(optionalString(url, 'cursor')),
    // One extra row is the cheapest possible "is there a next page".
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return json({
    items: page.map(toInvoiceSummary),
    next_cursor: hasMore && last ? encodeCursor(last.inv_date, last.inv_num) : null,
  });
}

export async function handleInvoiceDetail(db: D1Database, invNum: string): Promise<Response> {
  const invoice = await getInvoice(db, invNum);
  if (!invoice) throw notFound(`no invoice ${invNum}`);
  const items = await getItemsForInvoice(db, invNum);

  return json({
    invoice: toInvoiceSummary({ ...invoice, item_count: items.length }),
    items: items.map((item) => ({
      id: item.id,
      row_num: item.row_num,
      description: item.description,
      item_key: item.item_key,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      category: item.category_key,
      // The UI shows *why* an item was classified the way it was — the
      // difference between a rule and a guess is the whole trust story.
      category_source: item.category_source,
    })),
  });
}

function toInvoiceSummary(row: {
  inv_num: string;
  inv_date: IsoDate;
  inv_period: string | null;
  seller_ban: string | null;
  seller_name: string | null;
  amount: number;
  inv_status: string | null;
  detail_fetched_at: number | null;
  item_count: number;
}) {
  return {
    inv_num: row.inv_num,
    inv_date: row.inv_date,
    inv_period: row.inv_period,
    seller_ban: row.seller_ban,
    seller_name: row.seller_name,
    amount: row.amount,
    status: row.inv_status,
    details_pending: row.detail_fetched_at === null,
    item_count: row.item_count,
  };
}

/** `<date>|<invNum>`, base64'd so it survives a query string unexamined. */
function encodeCursor(invDate: IsoDate, invNum: string): string {
  return btoa(`${invDate}|${invNum}`);
}

function decodeCursor(raw: string | undefined): { invDate: IsoDate; invNum: string } | undefined {
  if (!raw) return undefined;
  try {
    const [invDate, invNum] = atob(raw).split('|');
    if (!invDate || !invNum) return undefined;
    return { invDate, invNum };
  } catch {
    return undefined; // a malformed cursor is a first page, not a 400
  }
}
