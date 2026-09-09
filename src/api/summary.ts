/**
 * `GET /api/summary?from=&to=&group=category|merchant|month`
 *
 * Backed by `v_monthly_category` where the grouping allows: the view owns the
 * cancelled-invoice exclusion, so the API has no aggregation rule of its own
 * to drift away from it. When the requested range is not whole months the
 * view's monthly granularity cannot answer, and the equivalent range query
 * runs instead.
 */
import {
  monthlyByCategory,
  summaryByCategory,
  summaryByMerchant,
  summaryByMonth,
  totalsForRange,
} from '../db/queries.js';
import { badRequest, dateRange, json } from './respond.js';
import type { IsoDate } from '../types.js';

type Grouping = 'category' | 'merchant' | 'month';

export async function handleSummary(db: D1Database, url: URL, today: IsoDate): Promise<Response> {
  const { from, to } = dateRange(url, today);
  if (from > to) throw badRequest('from must not be after to');

  const group = (url.searchParams.get('group') ?? 'category') as Grouping;
  if (!['category', 'merchant', 'month'].includes(group)) {
    throw badRequest('group must be category, merchant or month');
  }

  const totals = await totalsForRange(db, from, to);
  const breakdown = await buildBreakdown(db, group, from, to);

  return json({
    from,
    to,
    group,
    totals: {
      invoice_count: totals?.invoice_count ?? 0,
      invoice_total: totals?.invoice_total ?? 0,
      item_total: breakdown.reduce((sum, row) => sum + Number(row.total ?? 0), 0),
    },
    breakdown,
  });
}

async function buildBreakdown(
  db: D1Database,
  group: Grouping,
  from: IsoDate,
  to: IsoDate,
): Promise<Record<string, unknown>[]> {
  if (group === 'merchant') return (await summaryByMerchant(db, from, to)) as Record<string, unknown>[];

  if (group === 'month') {
    if (isWholeMonths(from, to)) {
      const rows = await monthlyByCategory(db, from.slice(0, 7), to.slice(0, 7));
      const byMonth = new Map<string, { key: string; label_en: string; total: number; item_count: number }>();
      for (const row of rows) {
        const entry = byMonth.get(row.month) ?? {
          key: row.month,
          label_en: row.month,
          total: 0,
          item_count: 0,
        };
        entry.total += row.total ?? 0;
        entry.item_count += row.item_count ?? 0;
        byMonth.set(row.month, entry);
      }
      return [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
    return (await summaryByMonth(db, from, to)) as Record<string, unknown>[];
  }

  if (isWholeMonths(from, to)) {
    const rows = await monthlyByCategory(db, from.slice(0, 7), to.slice(0, 7));
    const byCategory = new Map<string, { key: string; label_en: string; label_zh: string; total: number; item_count: number }>();
    for (const row of rows) {
      const key = row.category_key ?? 'uncategorized';
      const entry = byCategory.get(key) ?? {
        key,
        label_en: row.category_en ?? 'Uncategorized',
        label_zh: row.category_zh ?? '未分類',
        total: 0,
        item_count: 0,
      };
      entry.total += row.total ?? 0;
      entry.item_count += row.item_count ?? 0;
      byCategory.set(key, entry);
    }
    return [...byCategory.values()].sort((a, b) => b.total - a.total);
  }

  return (await summaryByCategory(db, from, to)) as Record<string, unknown>[];
}

/** The view is monthly; only a whole-month range can be answered from it. */
function isWholeMonths(from: IsoDate, to: IsoDate): boolean {
  if (from.slice(8, 10) !== '01') return false;
  const lastDay = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0))
    .toISOString()
    .slice(8, 10);
  return to.slice(8, 10) === lastDay;
}
