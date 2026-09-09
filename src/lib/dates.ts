/**
 * Date helpers. Everything internal is `YYYY-MM-DD`; the MOF API wants
 * `YYYY/MM/DD`, and the conversion happens only at that boundary.
 *
 * All arithmetic is done on the UTC calendar. The sync windows are days wide
 * and re-scan a week of overlap, so a timezone-sized error cannot lose data —
 * but keeping one convention means the watermark comparisons stay lexical.
 */
import type { IsoDate, Unix } from '../types.js';

const DAY = 86400;

export function toIsoDate(unix: Unix): IsoDate {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

export function isoToUnix(date: IsoDate): Unix {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return toIsoDate(isoToUnix(date) + days * DAY);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((isoToUnix(to) - isoToUnix(from)) / DAY);
}

/** Lexical order equals chronological order, which is the point of the format. */
export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a < b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a > b ? a : b;
}

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** `YYYY-MM-DD` → `YYYY/MM/DD`, the only form the MOF API accepts. */
export function toApiDate(date: IsoDate): string {
  return date.replace(/-/g, '/');
}

/**
 * MOF date → `YYYY-MM-DD`. Accepts `YYYY/MM/DD`, `YYYY-MM-DD` and the ROC
 * `1130415` / `113/04/15` forms, because the API is not consistent about
 * which one it returns and the difference is three digits of year.
 */
export function fromApiDate(value: string): IsoDate | null {
  const s = value.trim();

  const western = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (western) return pad(Number(western[1]), Number(western[2]), Number(western[3]));

  const rocSlash = s.match(/^(\d{2,3})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (rocSlash) {
    return pad(Number(rocSlash[1]) + 1911, Number(rocSlash[2]), Number(rocSlash[3]));
  }

  const rocPacked = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (rocPacked) {
    return pad(Number(rocPacked[1]) + 1911, Number(rocPacked[2]), Number(rocPacked[3]));
  }

  return null;
}

function pad(year: number, month: number, day: number): IsoDate | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ------------------------------------------------------------- ROC periods

/**
 * The two-month invoice period containing `date`, encoded the way the MOF
 * does it: ROC year plus the *even* month of the pair. 2024-03-15 → `11304`
 * (March–April of ROC 113).
 */
export function rocPeriodFor(date: IsoDate): string {
  const year = Number(date.slice(0, 4)) - 1911;
  const month = Number(date.slice(5, 7));
  const evenMonth = month % 2 === 0 ? month : month + 1;
  return `${year}${String(evenMonth).padStart(2, '0')}`;
}

/** First and last calendar day covered by a period like `11304`. */
export function periodRange(period: string): { start: IsoDate; end: IsoDate } {
  const year = Number(period.slice(0, 3)) + 1911;
  const evenMonth = Number(period.slice(3, 5));
  const start = `${year}-${String(evenMonth - 1).padStart(2, '0')}-01`;
  // Day 0 of the month after `evenMonth` is the last day of `evenMonth`.
  const end = new Date(Date.UTC(year, evenMonth, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** The period before the one containing `date`. */
export function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 3));
  const evenMonth = Number(period.slice(3, 5));
  if (evenMonth <= 2) return `${year - 1}12`;
  return `${year}${String(evenMonth - 2).padStart(2, '0')}`;
}
