/**
 * Window planning — the arithmetic the overlap re-scan and the bounded
 * invariant both rest on.
 */
import { describe, expect, it } from 'vitest';
import { planWindows } from '../src/sync/headers.js';
import { addDays, daysBetween, fromApiDate, toApiDate } from '../src/lib/dates.js';

const base = {
  carrierCreatedAt: '2026-01-01',
  today: '2026-09-05',
  overlapDays: 7,
  windowDays: 30,
  callBudget: 6,
};

describe('planWindows', () => {
  it('starts overlapDays before the watermark, never at it', () => {
    const [first] = planWindows({ ...base, syncedThrough: '2026-09-01' });
    expect(first?.start).toBe('2026-08-25');
    expect(first?.end).toBe('2026-09-05');
  });

  it('starts from the carrier creation date on the very first run', () => {
    const [first] = planWindows({ ...base, syncedThrough: null, carrierCreatedAt: '2026-08-20' });
    expect(first?.start).toBe('2026-08-13');
  });

  it('never plans a window ending after today', () => {
    const plans = planWindows({ ...base, syncedThrough: null });
    for (const plan of plans) expect(plan.end <= base.today).toBe(true);
  });

  it('respects the call budget however far behind it is', () => {
    const plans = planWindows({
      ...base,
      syncedThrough: null,
      carrierCreatedAt: '2020-01-01',
      callBudget: 3,
    });
    expect(plans).toHaveLength(3);
    // Bounded means bounded: a six-year backfill is many small runs.
    expect(plans[2]!.end < base.today).toBe(true);
  });

  it('produces contiguous, non-overlapping chunks within one run', () => {
    const plans = planWindows({ ...base, syncedThrough: null, carrierCreatedAt: '2026-06-01' });
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i]?.start).toBe(addDays(plans[i - 1]!.end, 1));
    }
  });

  it('stops at one window once caught up', () => {
    const plans = planWindows({ ...base, syncedThrough: '2026-09-05' });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({ start: '2026-08-29', end: '2026-09-05' });
  });

  it('clamps a watermark that somehow ran ahead of today', () => {
    const plans = planWindows({ ...base, syncedThrough: '2027-01-01' });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.start).toBe(base.today);
  });
});

describe('date conversion', () => {
  it('round-trips through the API form', () => {
    expect(toApiDate('2026-09-03')).toBe('2026/09/03');
    expect(fromApiDate('2026/09/03')).toBe('2026-09-03');
  });

  it('returns null for something that is not a date', () => {
    expect(fromApiDate('not a date')).toBeNull();
  });

  it('measures the gap the overlap window has to cover', () => {
    expect(daysBetween('2026-09-01', '2026-09-08')).toBe(7);
  });
});
