/**
 * Discount allocation.
 *
 * The invariant that matters is exactness: net amounts must sum to the
 * invoice total for every input, because a chart that is off by a dollar per
 * discounted invoice is a chart nobody can reconcile against their bank.
 */
import { describe, expect, it } from 'vitest';
import { allocateDiscounts, isDiscountRow } from '../src/import/allocate.js';

const items = (...amounts: number[]) => amounts.map((amount) => ({ amount }));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('allocateDiscounts', () => {
  it('leaves an invoice with no discount untouched', () => {
    expect(allocateDiscounts(items(35, 35, 28))).toEqual([35, 35, 28]);
  });

  it('nets the discount row to zero and spreads it over the rest', () => {
    // EY44910873 from real data: 59 + 39, less a 10% discount of 10.
    const net = allocateDiscounts(items(59, 39, -10));
    expect(net[2]).toBe(0);
    expect(sum(net)).toBe(88);
  });

  it('splits proportionally, not evenly', () => {
    // The larger line absorbs the larger share.
    const net = allocateDiscounts(items(90, 10, -50));
    expect(net).toEqual([45, 5, 0]);
  });

  it('sums to the invoice total exactly when the split does not divide evenly', () => {
    // 3 items, a discount that cannot be split into equal integers.
    const net = allocateDiscounts(items(10, 10, 10, -1));
    expect(sum(net)).toBe(29);
    // Exactly one line gives up the single dollar.
    expect(net.filter((n) => n === 9)).toHaveLength(1);
  });

  it('holds exactness across many awkward splits', () => {
    for (let discount = 1; discount <= 60; discount++) {
      for (const shape of [[7, 11, 13], [1, 1, 1, 1, 1, 1, 1], [100, 3], [5, 5, 5, 5, 5, 5]]) {
        const total = sum(shape) - discount;
        if (total < 0) continue;
        const net = allocateDiscounts(items(...shape, -discount));
        expect(sum(net)).toBe(total);
        // Allocation never turns a purchase into income.
        expect(net.every((n) => n >= 0)).toBe(true);
      }
    }
  });

  it('handles the real 寶雅 invoice, where the discount sits mid-list', () => {
    // ES35915268: -220 appears at position 2, between two identical 210 lines.
    const net = allocateDiscounts(items(210, -220, 210, 45, 45, 15, 15, 198, 239, 550));
    expect(net[1]).toBe(0);
    expect(sum(net)).toBe(1307);
    // The two identical lines are treated identically.
    expect(net[0]).toBe(net[2]);
  });

  it('never produces a negative line when the discount exceeds the subtotal', () => {
    const net = allocateDiscounts(items(10, 5, -100));
    expect(net).toEqual([0, 0, 0]);
  });

  it('leaves an invoice of only discounts alone rather than inventing a basis', () => {
    expect(allocateDiscounts(items(-30))).toEqual([-30]);
  });

  it('keeps zero-amount promotional lines at zero', () => {
    // Real 7-ELEVEN data has free items priced at 0.
    const net = allocateDiscounts(items(78, 48, 0, -10));
    expect(net[2]).toBe(0);
    expect(sum(net)).toBe(116);
  });

  it('is unaffected by the order the rows arrive in', () => {
    const a = sum(allocateDiscounts(items(210, -220, 210, 45)));
    const b = sum(allocateDiscounts(items(-220, 45, 210, 210)));
    expect(a).toBe(b);
  });
});

describe('isDiscountRow', () => {
  it('identifies negative lines only', () => {
    expect(isDiscountRow({ amount: -10 })).toBe(true);
    expect(isDiscountRow({ amount: 0 })).toBe(false);
    expect(isDiscountRow({ amount: 10 })).toBe(false);
  });
});
