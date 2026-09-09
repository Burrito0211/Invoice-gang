/**
 * Prize matching, tested against a draw that already happened rather than by
 * waiting two months for the next one — which is the only way this milestone
 * can be finished in an evening.
 */
import { describe, expect, it } from 'vitest';
import { invoiceDigits, matchInvoice } from '../src/prizes/match.js';
import { lastDrawnPeriod } from '../src/prizes/fetch.js';
import { periodRange, previousPeriod, rocPeriodFor } from '../src/lib/dates.js';
import type { PrizeClass } from '../src/types.js';

const winners: { prizeClass: PrizeClass; number: string }[] = [
  { prizeClass: 'special', number: '12345678' },
  { prizeClass: 'grand', number: '87654321' },
  { prizeClass: 'first', number: '11223344' },
  { prizeClass: 'first', number: '55667788' },
  { prizeClass: 'additional', number: '999' },
];

describe('invoiceDigits', () => {
  it('takes the eight digits however the invoice number is punctuated', () => {
    expect(invoiceDigits('AB12345678')).toBe('12345678');
    expect(invoiceDigits('AB-12345678')).toBe('12345678');
  });
});

describe('matchInvoice', () => {
  it('matches the special prize on all eight digits', () => {
    expect(matchInvoice('AB12345678', winners)).toMatchObject({
      prizeClass: 'special',
      amount: 10_000_000,
    });
  });

  it('matches the grand prize on all eight digits', () => {
    expect(matchInvoice('CD87654321', winners)).toMatchObject({
      prizeClass: 'grand',
      amount: 2_000_000,
    });
  });

  it('walks the first-prize ladder by suffix length', () => {
    expect(matchInvoice('AB11223344', winners)?.amount).toBe(200_000); // all 8
    expect(matchInvoice('AB91223344', winners)?.amount).toBe(40_000); // last 7
    expect(matchInvoice('AB99223344', winners)?.amount).toBe(10_000); // last 6
    expect(matchInvoice('AB99923344', winners)?.amount).toBe(4_000); // last 5
    expect(matchInvoice('AB99993344', winners)?.amount).toBe(1_000); // last 4
    expect(matchInvoice('AB99999344', winners)?.amount).toBe(200); // last 3
  });

  it('matches the additional prize on the last three digits', () => {
    expect(matchInvoice('AB11111999', winners)).toMatchObject({
      prizeClass: 'additional',
      amount: 200,
    });
  });

  it('returns the larger prize when an invoice matches two classes', () => {
    // 55667788 is a first-prize number; its last three (788) do not collide,
    // so construct one that matches the additional prize and a first-prize
    // suffix at once and check the ladder wins.
    const both: { prizeClass: PrizeClass; number: string }[] = [
      { prizeClass: 'first', number: '11223344' },
      { prizeClass: 'additional', number: '344' },
    ];
    expect(matchInvoice('AB11223344', both)?.amount).toBe(200_000);
  });

  it('returns null for a losing invoice', () => {
    expect(matchInvoice('AB00000000', winners)).toBeNull();
  });
});

describe('ROC periods', () => {
  it('encodes a period by the even month of its pair', () => {
    expect(rocPeriodFor('2024-03-15')).toBe('11304'); // March–April of ROC 113
    expect(rocPeriodFor('2024-04-01')).toBe('11304');
    expect(rocPeriodFor('2024-12-31')).toBe('11312');
    expect(rocPeriodFor('2024-01-05')).toBe('11302');
  });

  it('gives the calendar range a period covers', () => {
    expect(periodRange('11304')).toEqual({ start: '2024-03-01', end: '2024-04-30' });
    expect(periodRange('11312')).toEqual({ start: '2024-11-01', end: '2024-12-31' });
    // February in a leap year, which is the only interesting case here.
    expect(periodRange('11302')).toEqual({ start: '2024-01-01', end: '2024-02-29' });
  });

  it('steps back across a year boundary', () => {
    expect(previousPeriod('11302')).toBe('11212');
    expect(previousPeriod('11304')).toBe('11302');
  });

  it('only considers a period drawn once its numbers are published', () => {
    // Numbers for Mar–Apr (11304) are published on 25 May.
    expect(lastDrawnPeriod('2024-05-24')).toBe('11302');
    expect(lastDrawnPeriod('2024-05-25')).toBe('11304');
  });
});
