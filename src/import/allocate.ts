/**
 * Spreading invoice-level discounts across the items they discount.
 *
 * The export files discounts as their own rows with negative amounts —
 * `折扣（10％）`, `折扣金額` — and gives no indication of which item each one
 * applies to. Real data says it usually applies to all of them: the 10%
 * lines are exactly 10% of the invoice subtotal, and one observed `折扣金額`
 * of −220 sat between two identical 210 items, larger than either.
 *
 * So a discount is allocated **proportionally across the positive lines of
 * its own invoice**, and the discount row itself nets to zero. A NT$59 coffee
 * on an invoice with a 10% discount counts as NT$53, which is what was
 * actually spent, and the chart stops overstating every discounted purchase.
 *
 * Two properties this must hold, both tested:
 *
 *   1. **The net amounts sum to the invoice total exactly.** Proportional
 *      shares do not divide evenly, so the remainder is distributed by the
 *      largest-remainder method rather than left to rounding drift.
 *   2. **No float touches an amount.** The arithmetic is integer throughout —
 *      `amount * discount` divided by the subtotal, with the division's
 *      remainder used for ranking, never a ratio.
 *
 * Pure: no database, no clock. `amount` remains the untouched source of
 * truth; this only ever produces a derived `net_amount`.
 */

export interface AllocatableItem {
  /** Raw line amount from the export. Negative rows are the discounts. */
  amount: number;
}

/**
 * Net amounts, one per input item, in the same order.
 *
 * Discount rows net to 0 — their value has been pushed into the positive
 * lines — so summing the result gives the invoice total either way.
 */
export function allocateDiscounts<T extends AllocatableItem>(items: T[]): number[] {
  const net = items.map((item) => (item.amount > 0 ? item.amount : 0));

  const subtotal = items.reduce((sum, i) => (i.amount > 0 ? sum + i.amount : sum), 0);
  const discount = items.reduce((sum, i) => (i.amount < 0 ? sum - i.amount : sum), 0);

  // Nothing to spread, or nothing to spread it over. A credit note with no
  // positive lines keeps its rows untouched rather than inventing a basis.
  if (discount === 0 || subtotal === 0) {
    return items.map((item) => item.amount);
  }

  // A discount cannot take an invoice below zero. If one exceeds the
  // subtotal, everything nets to zero and the excess is dropped — better a
  // visibly free invoice than negative spending in a category.
  const spread = Math.min(discount, subtotal);

  // Largest remainder. `share` is the floor of the exact proportional cut and
  // `rank` is the numerator left over, both integers.
  const shares = items.map((item, index) => {
    if (item.amount <= 0) return { index, share: 0, rank: -1 };
    const numerator = item.amount * spread;
    return {
      index,
      share: Math.floor(numerator / subtotal),
      rank: numerator % subtotal,
    };
  });

  let remaining = spread - shares.reduce((sum, s) => sum + s.share, 0);

  // Biggest fractional part first; ties go to the larger line, then to the
  // earlier one, so the result never depends on sort stability.
  const order = shares
    .filter((s) => s.rank >= 0)
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      const amountA = items[a.index]!.amount;
      const amountB = items[b.index]!.amount;
      if (amountB !== amountA) return amountB - amountA;
      return a.index - b.index;
    });

  for (const entry of order) {
    if (remaining <= 0) break;
    entry.share += 1;
    remaining -= 1;
  }

  for (const entry of shares) {
    if (items[entry.index]!.amount > 0) {
      net[entry.index] = items[entry.index]!.amount - entry.share;
    }
  }

  return net;
}

/** A row that exists only to reduce the total, not to record a purchase. */
export function isDiscountRow(item: AllocatableItem): boolean {
  return item.amount < 0;
}
