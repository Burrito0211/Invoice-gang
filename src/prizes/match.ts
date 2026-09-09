/**
 * Prize matching, by class.
 *
 * The 統一發票 draw publishes three eight-digit numbers plus additional
 * numbers, and the prize depends on how long a matching *suffix* is:
 *
 *   特別獎 special   all 8 digits          10,000,000
 *   特獎   grand     all 8 digits           2,000,000
 *   頭獎   first     all 8 digits             200,000
 *                    last 7                    40,000
 *                    last 6                    10,000
 *                    last 5                     4,000
 *                    last 4                     1,000
 *                    last 3                       200
 *   增開六獎 additional  last 3                   200
 *
 * Pure: no network, no database. It takes the numbers and the invoice number
 * and returns the best prize, so it can be tested against invoices from a
 * draw that already happened rather than by waiting two months.
 */
import type { PrizeClass } from '../types.js';

export interface PrizeMatch {
  prizeClass: PrizeClass;
  amount: number;
  /** How many trailing digits matched — what actually determined the prize. */
  matchedDigits: number;
  number: string;
}

/** Suffix length → prize, for the 頭獎 ladder. */
const FIRST_PRIZE_LADDER: { digits: number; amount: number }[] = [
  { digits: 8, amount: 200_000 },
  { digits: 7, amount: 40_000 },
  { digits: 6, amount: 10_000 },
  { digits: 5, amount: 4_000 },
  { digits: 4, amount: 1_000 },
  { digits: 3, amount: 200 },
];

const SPECIAL_AMOUNT = 10_000_000;
const GRAND_AMOUNT = 2_000_000;
const ADDITIONAL_AMOUNT = 200;

/** The eight digits of an invoice number — `AB-12345678` and `AB12345678` agree. */
export function invoiceDigits(invNum: string): string {
  return invNum.replace(/\D/g, '').slice(-8);
}

/**
 * The best prize this invoice wins, or `null`. Every class is checked and the
 * highest amount returned: an invoice can match the additional-prize suffix
 * and the first-prize ladder at once, and it is worth the larger of the two.
 */
export function matchInvoice(
  invNum: string,
  winners: { prizeClass: PrizeClass; number: string }[],
): PrizeMatch | null {
  const digits = invoiceDigits(invNum);
  if (digits.length < 3) return null;

  // Collected rather than folded in place: TypeScript cannot narrow a `let`
  // that a closure reassigns, and the reduce at the end is clearer anyway.
  const candidates: PrizeMatch[] = [];
  const consider = (candidate: PrizeMatch) => candidates.push(candidate);

  for (const winner of winners) {
    const number = winner.number.replace(/\D/g, '');
    if (number.length === 0) continue;

    switch (winner.prizeClass) {
      case 'special':
        if (digits === number) {
          consider({ prizeClass: 'special', amount: SPECIAL_AMOUNT, matchedDigits: 8, number });
        }
        break;
      case 'grand':
        if (digits === number) {
          consider({ prizeClass: 'grand', amount: GRAND_AMOUNT, matchedDigits: 8, number });
        }
        break;
      case 'first':
        for (const rung of FIRST_PRIZE_LADDER) {
          if (suffixMatches(digits, number, rung.digits)) {
            consider({
              prizeClass: 'first',
              amount: rung.amount,
              matchedDigits: rung.digits,
              number,
            });
            break; // the ladder is ordered longest-first, so this is the best rung
          }
        }
        break;
      case 'additional':
        if (suffixMatches(digits, number, 3)) {
          consider({
            prizeClass: 'additional',
            amount: ADDITIONAL_AMOUNT,
            matchedDigits: 3,
            number,
          });
        }
        break;
    }
  }

  return candidates.reduce<PrizeMatch | null>(
    (best, candidate) => (best === null || candidate.amount > best.amount ? candidate : best),
    null,
  );
}

function suffixMatches(digits: string, number: string, length: number): boolean {
  if (digits.length < length || number.length < length) return false;
  return digits.slice(-length) === number.slice(-length);
}
