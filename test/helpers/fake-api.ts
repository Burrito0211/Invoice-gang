/**
 * A fake `EInvoiceApi` that replays fixtures.
 *
 * The MOF API cannot be called from a test suite, and the whole point of the
 * client/sync split is that it does not have to be. This fake is the other
 * half of that design: it serves headers by date range, details by invoice
 * number, and can be told to fail — with a quota error, a transport error, or
 * an empty detail response — at a chosen point.
 *
 * When Milestone 0 lands, the header and detail shapes here should be
 * replaced by the captured JSON in docs/api-samples/ run through
 * `einvoice/parse.ts`, so the tests exercise the real field names.
 */
import { QuotaError, TransportError } from '../../src/lib/errors.js';
import type { EInvoiceApi } from '../../src/einvoice/client.js';
import type { InvoiceDetailRow, InvoiceHeader, IsoDate, WinningNumbers } from '../../src/types.js';

export interface FakeApiOptions {
  headers?: InvoiceHeader[];
  details?: Record<string, InvoiceDetailRow[]>;
  winning?: WinningNumbers;
  /** Throw a quota error on the Nth detail call (1-based). */
  quotaOnDetailCall?: number;
  /** Throw a quota error on the Nth header call (1-based). */
  quotaOnHeaderCall?: number;
  /** Invoice numbers whose detail call throws a transport error. */
  failingInvoices?: Set<string>;
}

export class FakeEInvoiceApi implements EInvoiceApi {
  headerCalls: { start: IsoDate; end: IsoDate }[] = [];
  detailCalls: string[] = [];

  private headers: InvoiceHeader[];
  private details: Record<string, InvoiceDetailRow[]>;

  constructor(private readonly options: FakeApiOptions = {}) {
    this.headers = options.headers ? [...options.headers] : [];
    this.details = { ...(options.details ?? {}) };
  }

  /** Simulates a merchant filing an invoice late, after its date was synced. */
  fileLate(header: InvoiceHeader, details: InvoiceDetailRow[] = []): void {
    this.headers.push(header);
    if (details.length > 0) this.details[header.invNum] = details;
  }

  addDetails(invNum: string, rows: InvoiceDetailRow[]): void {
    this.details[invNum] = rows;
  }

  async carrierInvChk(range: { start: IsoDate; end: IsoDate }): Promise<InvoiceHeader[]> {
    this.headerCalls.push({ ...range });
    if (this.options.quotaOnHeaderCall === this.headerCalls.length) {
      throw new QuotaError('904', 'query limit reached (查詢次數超過限制)');
    }
    return this.headers.filter((h) => h.invDate >= range.start && h.invDate <= range.end);
  }

  async carrierInvDetail(header: { invNum: string }): Promise<InvoiceDetailRow[]> {
    this.detailCalls.push(header.invNum);
    if (this.options.quotaOnDetailCall === this.detailCalls.length) {
      throw new QuotaError('904', 'query limit reached (查詢次數超過限制)');
    }
    if (this.options.failingInvoices?.has(header.invNum)) {
      throw new TransportError('HTTP 500');
    }
    return this.details[header.invNum] ?? [];
  }

  async qryWinningList(invPeriod: string): Promise<WinningNumbers> {
    return this.options.winning ?? { invPeriod, numbers: [] };
  }
}

// ------------------------------------------------------------------ builders

let counter = 0;

export function header(overrides: Partial<InvoiceHeader> & { invDate: IsoDate }): InvoiceHeader {
  counter += 1;
  return {
    invNum: `AB${String(10_000_000 + counter)}`,
    invPeriod: null,
    sellerBan: '12345678',
    sellerName: '統一超商',
    amount: 100,
    invStatus: null,
    donatable: false,
    ...overrides,
  };
}

export function item(overrides: Partial<InvoiceDetailRow> = {}): InvoiceDetailRow {
  return {
    rowNum: 1,
    description: 'CITY CAFE 中杯拿鐵',
    quantity: 1,
    unitPrice: 55,
    amount: 55,
    ...overrides,
  };
}
