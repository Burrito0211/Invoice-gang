/**
 * `GET /api/prizes?period=` — the winning numbers for a period and this
 * account's `prize_hit` rows against them. The numbers are everyone's; the
 * hits are not.
 */
import { getWinningNumbers, listPrizeHits } from '../db/queries.js';
import { lastDrawnPeriod } from '../lib/dates.js';
import { badRequest, json } from './respond.js';
import type { IsoDate } from '../types.js';

export async function handlePrizes(
  db: D1Database,
  accountId: number,
  url: URL,
  today: IsoDate,
): Promise<Response> {
  const requested = url.searchParams.get('period');
  if (requested !== null && !/^\d{5}$/.test(requested)) {
    throw badRequest('period must be a five-digit ROC period, e.g. 11304');
  }
  const period = requested ?? lastDrawnPeriod(today);

  const [numbers, hits] = await Promise.all([
    getWinningNumbers(db, period),
    listPrizeHits(db, accountId, period),
  ]);

  return json({ period, numbers, hits });
}
