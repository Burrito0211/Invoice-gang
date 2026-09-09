/**
 * The carrier CSV export → domain types.
 *
 * This replaces `einvoice/parse.ts` as the entry point for invoice data, and
 * keeps the same boundary: it is pure. No HTTP, no database. Everything it
 * knows about the file was verified against a real export rather than
 * assumed — the mistake that cost us `einvoice/`.
 *
 * The file is a flattened join: **one row per line item**, with the invoice's
 * own fields repeated on every row. 14 columns, UTF-8 with a BOM, and two
 * prose footer lines that are not data.
 *
 * Three things about it are counterintuitive enough to be worth stating:
 *
 *   1. **`發票金額` is not the invoice total.** It carries the *line* amount,
 *      identical to `消費明細_金額` on every row of a real export. Summing the
 *      lines is the only way to get the invoice total; taking the column at
 *      face value stores whichever row happened to land last.
 *   2. **There is no row number.** It has to come from position within the
 *      invoice, because a real export contains invoices with two lines that
 *      are identical in name, quantity and amount — so content cannot be the
 *      key without silently merging two genuine purchases.
 *   3. **Negative lines are normal.** Discounts (`折扣（10％）`) appear as
 *      items with negative amounts, and they are what make the total add up.
 */
import { fromApiDate } from '../lib/dates.js';
import type { InvoiceDetailRow, InvoiceHeader, IsoDate } from '../types.js';

/** Column order of the export, used to validate the header row. */
export const EXPECTED_COLUMNS = [
  '載具自訂名稱',
  '發票日期',
  '發票號碼',
  '發票金額',
  '發票狀態',
  '折讓',
  '賣方統一編號',
  '賣方名稱',
  '賣方地址',
  '買方統編',
  '消費明細_數量',
  '消費明細_單價',
  '消費明細_金額',
  '消費明細_品名',
] as const;

const COL = {
  carrierLabel: 0,
  invDate: 1,
  invNum: 2,
  lineAmountDuplicate: 3,
  invStatus: 4,
  allowance: 5,
  sellerBan: 6,
  sellerName: 7,
  sellerAddress: 8,
  buyerBan: 9,
  quantity: 10,
  unitPrice: 11,
  amount: 12,
  description: 13,
} as const;

/**
 * A voided or donated invoice arrives with the last three digits of its
 * number masked — the export says so in its own footer. `inv_num` is our
 * primary key, so these are marked rather than trusted.
 */
const WELL_FORMED_INV_NUM = /^[A-Z]{2}[0-9]{8}$/;

/** Written into `inv_status` so a masked invoice stays visible and countable. */
export const MASKED_STATUS_SUFFIX = ' (號碼隱碼)';

export interface ParsedInvoice {
  header: InvoiceHeader;
  items: InvoiceDetailRow[];
  /** True when the invoice number had digits masked by the export. */
  masked: boolean;
}

export interface ParseResult {
  invoices: ParsedInvoice[];
  /** Row-level problems, kept rather than thrown — one bad line is not a bad file. */
  skipped: { line: number; reason: string }[];
  carrierLabel: string | null;
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvFormatError';
  }
}

export function parseCarrierCsv(text: string): ParseResult {
  const lines = splitLines(stripBom(text));
  if (lines.length === 0) throw new CsvFormatError('file is empty');

  const headerCells = parseCsvLine(lines[0]!.text);
  assertHeader(headerCells);

  const skipped: ParseResult['skipped'] = [];
  // Grouped by invoice number, insertion-ordered — which is what makes the
  // positional row number stable for a given export.
  const groups = new Map<string, string[][]>();
  let carrierLabel: string | null = null;

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line.text);

    // The export ends with prose notes about voiding and allowances. They are
    // not rows and must not be parsed as any.
    if (cells.length === 1) continue;

    if (cells.length !== EXPECTED_COLUMNS.length) {
      skipped.push({
        line: line.number,
        reason: `expected ${EXPECTED_COLUMNS.length} fields, got ${cells.length}`,
      });
      continue;
    }

    const invNum = (cells[COL.invNum] ?? '').trim().toUpperCase();
    if (invNum === '') {
      skipped.push({ line: line.number, reason: 'no invoice number' });
      continue;
    }
    if (fromApiDate(cells[COL.invDate] ?? '') === null) {
      skipped.push({ line: line.number, reason: `unparseable date ${cells[COL.invDate]}` });
      continue;
    }

    carrierLabel ??= (cells[COL.carrierLabel] ?? '').trim() || null;
    const group = groups.get(invNum);
    if (group) group.push(cells);
    else groups.set(invNum, [cells]);
  }

  const invoices: ParsedInvoice[] = [];
  for (const [invNum, rows] of groups) {
    invoices.push(buildInvoice(invNum, rows));
  }

  return { invoices, skipped, carrierLabel };
}

function buildInvoice(invNum: string, rows: string[][]): ParsedInvoice {
  const first = rows[0]!;
  const invDate = fromApiDate(first[COL.invDate] ?? '') as IsoDate;
  const masked = !WELL_FORMED_INV_NUM.test(invNum);

  const items: InvoiceDetailRow[] = rows.map((cells, index) => ({
    // Position within this invoice's rows. See note 2 at the top of the file.
    rowNum: index + 1,
    description: (cells[COL.description] ?? '').trim(),
    quantity: numberOrNull(cells[COL.quantity]),
    unitPrice: moneyOrNull(cells[COL.unitPrice]),
    amount: money(cells[COL.amount]),
  }));

  // See note 1: the column named 發票金額 holds the line amount, so the
  // invoice total is the sum of its lines and nothing else.
  const amount = items.reduce((sum, item) => sum + item.amount, 0);

  const rawStatus = (first[COL.invStatus] ?? '').trim() || null;
  const status = masked && rawStatus ? `${rawStatus}${MASKED_STATUS_SUFFIX}` : rawStatus;

  return {
    header: {
      invNum,
      invDate,
      invPeriod: null, // not in the export; derived from the date where needed
      sellerBan: (first[COL.sellerBan] ?? '').trim() || null,
      sellerName: (first[COL.sellerName] ?? '').trim() || null,
      amount,
      invStatus: status,
      donatable: false,
    },
    items,
    masked,
  };
}

function assertHeader(cells: string[]): void {
  const actual = cells.map((c) => c.trim());
  const missing = EXPECTED_COLUMNS.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new CsvFormatError(
      `not a carrier invoice export — missing column(s): ${missing.join(', ')}`,
    );
  }
  // Positional access is only safe if the order is the one that was verified.
  for (let i = 0; i < EXPECTED_COLUMNS.length; i++) {
    if (actual[i] !== EXPECTED_COLUMNS[i]) {
      throw new CsvFormatError(
        `column ${i} is ${JSON.stringify(actual[i])}, expected ${JSON.stringify(EXPECTED_COLUMNS[i])} — the export format changed`,
      );
    }
  }
}

// ------------------------------------------------------------------ parsing

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitLines(text: string): { number: number; text: string }[] {
  return text
    .split(/\r?\n/)
    .map((t, i) => ({ number: i + 1, text: t }))
    .filter((l) => l.text.trim() !== '');
}

/**
 * A real CSV line reader rather than `split(',')`. The verified sample uses no
 * quoting, but product names are raw merchant POS text and nothing stops one
 * containing a comma; splitting naively would shift every later column.
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/** Money is INTEGER everywhere; negatives are legitimate discount lines. */
function money(value: string | undefined): number {
  const n = numberOrNull(value);
  return n === null ? 0 : Math.round(n);
}

function moneyOrNull(value: string | undefined): number | null {
  const n = numberOrNull(value);
  return n === null ? null : Math.round(n);
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.replace(/[,\s]/g, '');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
