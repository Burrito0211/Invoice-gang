/**
 * `GET /api/prizes?period=` — the winning numbers for a period and any
 * `prize_hit` rows against them.
 */
import { getWinningNumbers, listPrizeHits } from '../db/queries.js';
import { lastDrawnPeriod } from '../prizes/fetch.js';
import { badRequest, json } from './respond.js';
import type { IsoDate } from '../types.js';

export async function handlePrizes(db: D1Database, url: URL, today: IsoDate): Promise<Response> {
  const requested = url.searchParams.get('period');
  if (requested !== null && !/^\d{5}$/.test(requested)) {
    throw badRequest('period must be a five-digit ROC period, e.g. 11304');
  }
  const period = requested ?? lastDrawnPeriod(today);

  const [numbers, hits] = await Promise.all([
    getWinningNumbers(db, period),
    listPrizeHits(db, period),
  ]);

  return json({ period, numbers, hits });
}
