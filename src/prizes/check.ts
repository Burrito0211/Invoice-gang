/**
 * Match stored invoices against stored winning numbers.
 *
 * This used to fetch the numbers from `qryWinningList`, which needs an App ID
 * the MOF no longer issues to individuals. The matching itself never needed
 * the API — it needs a list of numbers and a list of invoices — so the fetch
 * is gone and the numbers come from the `winning_number` table by whatever
 * route puts them there.
 *
 * Until there is an automated source, seeding is manual:
 *
 *   INSERT INTO winning_number (inv_period, prize_class, number, fetched_at)
 *   VALUES ('11510', 'special', '12345678', unixepoch());
 *
 * Six rows, six times a year. `prizes/match.ts` does the rest.
 *
 * The numbers are shared; the invoices are every account's, read together
 * because the draw is the same for all of them; and each hit is recorded
 * against its own account and sent only to that account's webhook. A hit is
 * notified once — `notified_at` is stamped after the send, so a re-run cannot
 * notify twice — and an account with no webhook keeps its hits unsent, so
 * setting one later still delivers them.
 */
import {
  getWinningNumbers,
  insertPrizeHitStatement,
  listInvoiceNumbersForPeriod,
  listUnnotifiedPrizeHits,
  markPrizeNotified,
} from '../db/queries.js';
import { lastDrawnPeriod, periodRange, toIsoDate } from '../lib/dates.js';
import { matchInvoice, type PrizeMatch } from './match.js';
import type { PrizeClass, Unix } from '../types.js';

export interface PrizeCheckResult {
  invPeriod: string;
  /** False when no numbers have been recorded for the period yet. */
  hasNumbers: boolean;
  invoicesChecked: number;
  hits: number;
  notified: number;
}

export interface PrizeDeps {
  db: D1Database;
  now: () => Unix;
  /** Sends one message to one account's webhook. Absent means record hits, send nothing. */
  notify?: (webhook: string, message: string) => Promise<void>;
}

export async function checkPrizes(
  deps: PrizeDeps,
  invPeriod?: string,
): Promise<PrizeCheckResult> {
  const now = deps.now();
  const period = invPeriod ?? lastDrawnPeriod(toIsoDate(now));
  const result: PrizeCheckResult = {
    invPeriod: period,
    hasNumbers: false,
    invoicesChecked: 0,
    hits: 0,
    notified: 0,
  };

  const winners = await getWinningNumbers(deps.db, period);
  if (winners.length === 0) return result;
  result.hasNumbers = true;

  const numbers = winners.map((w) => ({
    prizeClass: w.prize_class as PrizeClass,
    number: w.number,
  }));
  const invoices = await listInvoiceNumbersForPeriod(deps.db, period, periodRange(period));
  result.invoicesChecked = invoices.length;

  const hits: { accountId: number; invNum: string; match: PrizeMatch }[] = [];
  for (const invoice of invoices) {
    const match = matchInvoice(invoice.inv_num, numbers);
    if (match) hits.push({ accountId: invoice.account_id, invNum: invoice.inv_num, match });
  }

  if (hits.length > 0) {
    await deps.db.batch(
      hits.map((h) =>
        insertPrizeHitStatement(deps.db, {
          accountId: h.accountId,
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

  if (deps.notify) {
    for (const hit of await listUnnotifiedPrizeHits(deps.db)) {
      await deps.notify(
        hit.notify_webhook,
        `發票中獎 — ${hit.inv_num} (${hit.seller_name ?? 'unknown merchant'}, ${hit.inv_date}) ` +
          `won NT$${hit.amount.toLocaleString('en-US')} [${hit.prize_class}]`,
      );
      await markPrizeNotified(deps.db, hit.account_id, hit.inv_num, deps.now());
      result.notified += 1;
    }
  }

  return result;
}
