/**
 * Budget pacing and carry-forward.
 *
 * The arithmetic is pure, so most of this needs no database: what it is
 * actually guarding is the set of month boundaries where a naive
 * implementation divides by zero or quietly judges a finished month against a
 * budget set after it ended.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daysInMonth, monthRange, pace } from '../src/budget/pace.js';
import { deleteBudget, getEffectiveBudget, upsertBudget } from '../src/db/queries.js';
import { handleGetBudget, handleSetBudget } from '../src/api/budget.js';
import { createTestDb, seedCarrier } from './helpers/d1.js';

describe('daysInMonth', () => {
  it('knows the short months and the leap years', () => {
    expect(daysInMonth('2026-09')).toBe(30);
    expect(daysInMonth('2026-10')).toBe(31);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
  });
});

describe('pace mid-month', () => {
  const result = pace({ month: '2026-09', amount: 20_000, spent: 12_400, today: '2026-09-12' });

  it('counts today as elapsed and the rest as left', () => {
    expect(result.days_in_month).toBe(30);
    expect(result.days_elapsed).toBe(12);
    expect(result.days_left).toBe(18);
  });

  it('projects from the pace so far', () => {
    expect(result.pace_per_day).toBe(1033); // 12400 / 12
    expect(result.projected).toBe(31_000); // 12400 / 12 * 30
    expect(result.over_by).toBe(11_000);
  });

  it('spreads what is left over the days that have not started', () => {
    expect(result.remaining).toBe(7_600);
    expect(result.remaining_per_day).toBe(422); // 7600 / 18
    expect(result.allowed_per_day).toBe(667); // 20000 / 30
  });

  it('reports every amount as a whole number of NT$', () => {
    for (const value of [
      result.spent,
      result.remaining,
      result.pace_per_day,
      result.projected,
      result.allowed_per_day,
      result.remaining_per_day,
      result.over_by,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe('status', () => {
  const at = (spent: number, today = '2026-09-12') =>
    pace({ month: '2026-09', amount: 20_000, spent, today }).status;

  it('separates already-over from heading-over', () => {
    // Spent more than the whole budget: nothing to slow down into.
    expect(at(21_000)).toBe('over');
    // Inside the budget today, past it by month end at this rate.
    expect(at(12_400)).toBe('projected_over');
    // 8000 over 12 days projects to 20000 exactly — not over.
    expect(at(8_000)).toBe('on_track');
  });

  it('is unset rather than zero when no budget exists', () => {
    const result = pace({ month: '2026-09', amount: null, spent: 5_000, today: '2026-09-12' });
    expect(result.status).toBe('unset');
    expect(result.amount).toBeNull();
    expect(result.remaining).toBeNull();
    expect(result.over_by).toBeNull();
    expect(result.remaining_per_day).toBeNull();
    // Spend and pace are still real numbers — they do not need a budget.
    expect(result.spent).toBe(5_000);
    expect(result.pace_per_day).toBe(417);
  });
});

describe('month boundaries', () => {
  it('treats the last day as fully elapsed with nothing left to spread', () => {
    const result = pace({ month: '2026-09', amount: 20_000, spent: 18_000, today: '2026-09-30' });
    expect(result.days_elapsed).toBe(30);
    expect(result.days_left).toBe(0);
    // No days left to divide by; the remaining figure itself is the answer.
    expect(result.remaining_per_day).toBeNull();
    expect(result.projected).toBe(18_000);
  });

  it('does not project a finished month beyond what it actually cost', () => {
    const result = pace({ month: '2026-08', amount: 20_000, spent: 17_000, today: '2026-09-12' });
    expect(result.days_elapsed).toBe(31);
    expect(result.days_left).toBe(0);
    expect(result.projected).toBe(17_000);
    expect(result.status).toBe('on_track');
  });

  it('survives a month that has not started', () => {
    const result = pace({ month: '2026-10', amount: 20_000, spent: 0, today: '2026-09-12' });
    expect(result.days_elapsed).toBe(0);
    expect(result.days_left).toBe(31);
    // The division that would be by zero.
    expect(result.pace_per_day).toBe(0);
    expect(result.projected).toBe(0);
    expect(result.status).toBe('on_track');
  });
});

describe('monthRange', () => {
  it('covers the whole month, short ones included', () => {
    expect(monthRange('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('carry-forward', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    db = createTestDb();
    await seedCarrier(db, 1_750_000_000);
  });

  afterEach(() => db.close());

  it('applies the newest budget at or before the month asked for', async () => {
    await upsertBudget(db, { month: '2026-07', amount: 18_000, now: 1 });

    // A month with no row of its own inherits rather than being unbudgeted.
    expect((await getEffectiveBudget(db, '2026-09'))?.amount).toBe(18_000);
    expect((await getEffectiveBudget(db, '2026-07'))?.amount).toBe(18_000);
  });

  it('does not reach backwards, so a past month keeps the figure it was lived under', async () => {
    await upsertBudget(db, { month: '2026-09', amount: 25_000, now: 1 });
    expect(await getEffectiveBudget(db, '2026-08')).toBeNull();
  });

  it('lets a later month supersede an earlier one', async () => {
    await upsertBudget(db, { month: '2026-07', amount: 18_000, now: 1 });
    await upsertBudget(db, { month: '2026-09', amount: 25_000, now: 2 });

    expect((await getEffectiveBudget(db, '2026-08'))?.amount).toBe(18_000);
    expect((await getEffectiveBudget(db, '2026-09'))?.amount).toBe(25_000);
    expect((await getEffectiveBudget(db, '2026-12'))?.amount).toBe(25_000);
  });

  it('updates in place rather than stacking rows for the same month', async () => {
    await upsertBudget(db, { month: '2026-09', amount: 20_000, now: 1 });
    await upsertBudget(db, { month: '2026-09', amount: 22_000, now: 2 });

    const row = await getEffectiveBudget(db, '2026-09');
    expect(row?.amount).toBe(22_000);
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM budget`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('falls back to the previous change point when one is deleted', async () => {
    await upsertBudget(db, { month: '2026-07', amount: 18_000, now: 1 });
    await upsertBudget(db, { month: '2026-09', amount: 25_000, now: 2 });

    expect(await deleteBudget(db, '2026-09')).toBe(true);
    expect((await getEffectiveBudget(db, '2026-09'))?.amount).toBe(18_000);
  });
});

describe('the endpoint', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    db = createTestDb();
    await seedCarrier(db, 1_750_000_000);
  });

  afterEach(() => db.close());

  const get = async (month: string, today: string) =>
    (await (
      await handleGetBudget(db, new URL(`https://x/api/budget?month=${month}`), today)
    ).json()) as Record<string, unknown>;

  it('reports unset before a budget exists', async () => {
    const body = await get('2026-09', '2026-09-12');
    expect(body.status).toBe('unset');
    expect(body.amount).toBeNull();
    expect(body.effective_from).toBeNull();
  });

  it('says which month the figure came from when it was carried forward', async () => {
    await upsertBudget(db, { month: '2026-07', amount: 18_000, now: 1 });
    const body = await get('2026-09', '2026-09-12');
    expect(body.amount).toBe(18_000);
    expect(body.effective_from).toBe('2026-07');
  });

  it('defaults to the current month when none is given', async () => {
    await upsertBudget(db, { month: '2026-09', amount: 20_000, now: 1 });
    const response = await handleGetBudget(db, new URL('https://x/api/budget'), '2026-09-12');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.month).toBe('2026-09');
  });

  it('answers a PUT with the pacing the new figure implies', async () => {
    const request = new Request('https://x/api/budget', {
      method: 'PUT',
      body: JSON.stringify({ month: '2026-09', amount: 20_000 }),
    });
    const response = await handleSetBudget(db, request, new URL('https://x/api/budget'), '2026-09-12', 1);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.amount).toBe(20_000);
    expect(body.remaining).toBe(20_000); // nothing imported in this database
    expect(body.effective_from).toBe('2026-09');
  });

  it('refuses an amount that is not a positive integer', async () => {
    for (const amount of [0, -5, 1.5, 'lots']) {
      const request = new Request('https://x/api/budget', {
        method: 'PUT',
        body: JSON.stringify({ month: '2026-09', amount }),
      });
      await expect(
        handleSetBudget(db, request, new URL('https://x/api/budget'), '2026-09-12', 1),
      ).rejects.toThrow(/positive integer/);
    }
  });

  it('refuses a month that is not YYYY-MM', async () => {
    for (const month of ['2026-13', '2026-9', '2026', 'september']) {
      await expect(
        handleGetBudget(db, new URL(`https://x/api/budget?month=${month}`), '2026-09-12'),
      ).rejects.toThrow(/YYYY-MM/);
    }
  });
});
