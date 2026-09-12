/**
 * Budget pacing. Pure — no database, no HTTP, no clock: it takes the month,
 * the budget, what has been spent and what day it is, and returns the numbers
 * the dashboard prints. Same boundary as `import/csv.ts` and
 * `categorize/rules.ts`, and for the same reason: this is arithmetic with
 * edge cases at every month boundary, and arithmetic is only testable when
 * nothing else is in the room.
 *
 * Money stays INTEGER. Per-day figures are genuine fractions, so they are
 * rounded to whole NT$ *here*, at the edge, and every amount that leaves this
 * module is a whole number of dollars.
 */
import type { IsoDate } from '../types.js';

/** Every figure the budget card shows. Amounts are NT$ integers. */
export interface BudgetPace {
  month: string;
  /** null when no budget has ever been set at or before this month. */
  amount: number | null;
  spent: number;
  remaining: number | null;
  days_in_month: number;
  /** Days of the month gone, today included — today is a day you spend on. */
  days_elapsed: number;
  /** Days after today. Zero on the last day of the month. */
  days_left: number;
  /** What the budget allows per day if spread evenly. */
  allowed_per_day: number | null;
  /** What you have actually averaged so far. */
  pace_per_day: number;
  /** What is left, spread over the days that have not started yet. */
  remaining_per_day: number | null;
  /** Month-end total if the current pace holds. */
  projected: number;
  /** projected − amount. Negative means projected to come in under. */
  over_by: number | null;
  status: BudgetStatus;
}

/**
 * `over` means the budget is already gone; `projected_over` means it is not
 * yet but will be at this rate. They call for different things — one is a
 * stop, the other is a slow down — so they are not collapsed into one flag.
 */
export type BudgetStatus = 'unset' | 'over' | 'projected_over' | 'on_track';

export function daysInMonth(month: string): number {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

/**
 * `today` positions the month in time. A month already over is fully elapsed
 * and has nothing left to project; a month not yet started has elapsed
 * nothing, and dividing by that would be the obvious crash.
 */
export function pace(input: {
  month: string;
  amount: number | null;
  spent: number;
  today: IsoDate;
}): BudgetPace {
  const { month, amount, spent, today } = input;
  const total = daysInMonth(month);
  const todayMonth = today.slice(0, 7);

  const elapsed =
    todayMonth > month ? total : todayMonth < month ? 0 : Math.min(Number(today.slice(8, 10)), total);
  const left = total - elapsed;

  const pacePerDay = elapsed === 0 ? 0 : Math.round(spent / elapsed);
  const projected = elapsed === 0 ? 0 : Math.round((spent / elapsed) * total);

  const remaining = amount === null ? null : amount - spent;
  const overBy = amount === null ? null : projected - amount;

  return {
    month,
    amount,
    spent,
    remaining,
    days_in_month: total,
    days_elapsed: elapsed,
    days_left: left,
    allowed_per_day: amount === null ? null : Math.round(amount / total),
    pace_per_day: pacePerDay,
    // Today's spending is already inside `spent`, so what is left belongs to
    // the days that have not started. On the last day there are none, and the
    // remaining figure itself is the answer.
    remaining_per_day: remaining === null || left === 0 ? null : Math.round(remaining / left),
    projected,
    over_by: overBy,
    status: statusOf(amount, spent, projected),
  };
}

function statusOf(amount: number | null, spent: number, projected: number): BudgetStatus {
  if (amount === null) return 'unset';
  if (spent > amount) return 'over';
  if (projected > amount) return 'projected_over';
  return 'on_track';
}

/** First and last calendar day of `YYYY-MM`, for querying spend. */
export function monthRange(month: string): { from: IsoDate; to: IsoDate } {
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };
}

export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
