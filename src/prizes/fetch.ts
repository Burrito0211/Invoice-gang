/**
 * Phase 4 — prizes.
 *
 * Cheap and only worth doing occasionally: the numbers change six times a
 * year, so they are fetched once per period and cached. If `winning_number`
 * already has rows for the period there is nothing to do.
 *
 * A hit writes `prize_hit` and, if unnotified, notifies and stamps
 * `notified_at` — so a re-run cannot notify twice.
 */
import {
  getWinningNumbers,
  insertPrizeHitStatement,
  insertWinningNumberStatement,
  listInvoiceNumbersForPeriod,
  listUnnotifiedPrizeHits,
  markPrizeNotified,
} from '../db/queries.js';
import { periodRange, previousPeriod, rocPeriodFor, toIsoDate } from '../lib/dates.js';
import { matchInvoice } from './match.js';
import type { EInvoiceApi } from '../einvoice/client.js';
import type { PrizeClass, Unix } from '../types.js';

export interface PrizeCheckResult {
  invPeriod: string;
  numbersFetched: number;
  invoicesChecked: number;
  hits: number;
  notified: number;
  skipped: 'already-cached' | null;
}

export interface PrizeDeps {
  api: EInvoiceApi;
  db: D1Database;
  now: () => Unix;
  /** Absent in tests and when no notification channel is configured. */
  notify?: (message: string) => Promise<void>;
}

/**
 * The most recent period whose draw has happened. Numbers for a period are
 * published on the 25th of the month after it closes, so checking the period
 * that just ended before that date finds nothing — check the one before it.
 */
export function lastDrawnPeriod(today: string): string {
  const current = rocPeriodFor(today);
  const previous = previousPeriod(current);
  const day = Number(today.slice(8, 10));
  const month = Number(today.slice(5, 7));
  // The draw for the period ending in `evenMonth` lands on the 25th of
  // `evenMonth + 1`. Before that date the previous period is the newest one
  // with published numbers.
  const drawHappened = month % 2 === 1 && day >= 25;
  return drawHappened ? previous : previousPeriod(previous);
}

export async function checkPrizes(
  deps: PrizeDeps,
  invPeriod?: string,
): Promise<PrizeCheckResult> {
  const now = deps.now();
  const period = invPeriod ?? lastDrawnPeriod(toIsoDate(now));
  const result: PrizeCheckResult = {
    invPeriod: period,
    numbersFetched: 0,
    invoicesChecked: 0,
    hits: 0,
    notified: 0,
    skipped: null,
  };

  let winners = await getWinningNumbers(deps.db, period);
  if (winners.length === 0) {
    const fetched = await deps.api.qryWinningList(period);
    if (fetched.numbers.length > 0) {
      await deps.db.batch(
        fetched.numbers.map((n) =>
          insertWinningNumberStatement(deps.db, {
            invPeriod: period,
            prizeClass: n.prizeClass,
            number: n.number,
            now,
          }),
        ),
      );
      result.numbersFetched = fetched.numbers.length;
      winners = await getWinningNumbers(deps.db, period);
    }
  } else {
    result.skipped = 'already-cached';
  }

  if (winners.length === 0) return result;

  const numbers = winners.map((w) => ({
    prizeClass: w.prize_class as PrizeClass,
    number: w.number,
  }));
  const invoices = await listInvoiceNumbersForPeriod(deps.db, period, periodRange(period));
  result.invoicesChecked = invoices.length;

  const hits = invoices
    .map((i) => ({ invNum: i.inv_num, match: matchInvoice(i.inv_num, numbers) }))
    .filter((h): h is { invNum: string; match: NonNullable<ReturnType<typeof matchInvoice>> } =>
      h.match !== null,
    );

  if (hits.length > 0) {
    await deps.db.batch(
      hits.map((h) =>
        insertPrizeHitStatement(deps.db, {
          invNum: h.invNum,
          invPeriod: period,
          prizeClass: h.match.prizeClass,
          amount: h.match.amount,
          now,
        }),
      ),
    );
    result.hits = hits.length;
  }

  // Notify only what has never been notified. `notified_at` is stamped after
  // the send, so a crash between the two retries rather than double-notifies.
  if (deps.notify) {
    for (const hit of await listUnnotifiedPrizeHits(deps.db)) {
      await deps.notify(
        `發票中獎 — ${hit.inv_num} (${hit.seller_name ?? 'unknown merchant'}, ${hit.inv_date}) ` +
          `won NT$${hit.amount.toLocaleString('en-US')} [${hit.prize_class}]`,
      );
      await markPrizeNotified(deps.db, hit.inv_num, deps.now());
      result.notified += 1;
    }
  }

  return result;
}
