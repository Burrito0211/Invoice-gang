/**
 * Transport for the MOF e-invoice API.
 *
 * Two rules define this file:
 *
 *   1. It never touches the database. It returns parsed domain objects and
 *      knows nothing about storage — that is what lets the sync be tested
 *      with a fake client and no network.
 *   2. It is the single place credentials are scrubbed. `cardNo` and
 *      `cardEncrypt` must never reach a log line, a `sync_run.error`, or an
 *      API response, and scrubbing here rather than at each log site means
 *      there is exactly one place to get it right.
 */
import { EInvoiceError, QuotaError, TransportError } from '../lib/errors.js';
import { toApiDate } from '../lib/dates.js';
import { parseDetails, parseEnvelope, parseHeaders, parseWinningNumbers } from './parse.js';
import type {
  CarrierCredentials,
  InvoiceDetailRow,
  InvoiceHeader,
  IsoDate,
  WinningNumbers,
} from '../types.js';

/**
 * The interface the sync depends on. `sync/` takes one of these as a
 * parameter and never constructs it, so a test can substitute a fake that
 * replays captured JSON.
 */
export interface EInvoiceApi {
  /** Invoice headers for the carrier over an inclusive date range. */
  carrierInvChk(range: { start: IsoDate; end: IsoDate }): Promise<InvoiceHeader[]>;

  /** Line items for one invoice. An empty array is not proof there are none. */
  carrierInvDetail(header: {
    invNum: string;
    invDate: IsoDate;
    amount: number;
    sellerName: string | null;
    sellerBan: string | null;
  }): Promise<InvoiceDetailRow[]>;

  /** Public data — no carrier credentials involved. */
  qryWinningList(invPeriod: string): Promise<WinningNumbers>;
}

export interface ClientOptions {
  baseUrl: string;
  appId: string;
  uuid: string;
  credentials: CarrierCredentials;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
  /** Total attempts per call, including the first. */
  maxAttempts?: number;
  /** Base backoff in milliseconds; doubled per retry. */
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const INV_SERV_PATH = '/PB2CAPIVAN/invServ/InvServ';
const INV_APP_PATH = '/PB2CAPIVAN/invapp/InvApp';

/** `expTimeStamp` must be in the future; ten minutes is comfortably clear. */
const EXPIRY_SECONDS = 600;

export class EInvoiceClient implements EInvoiceApi {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly uuid: string;
  private readonly credentials: CarrierCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.appId = options.appId;
    this.uuid = options.uuid;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async carrierInvChk(range: { start: IsoDate; end: IsoDate }): Promise<InvoiceHeader[]> {
    const body = await this.post(INV_SERV_PATH, {
      version: '1.0',
      action: 'carrierInvChk',
      ...this.carrierParams(),
      startDate: toApiDate(range.start),
      endDate: toApiDate(range.end),
      onlyWinningInv: 'N',
    });
    return parseHeaders(body);
  }

  async carrierInvDetail(header: {
    invNum: string;
    invDate: IsoDate;
    amount: number;
    sellerName: string | null;
    sellerBan: string | null;
  }): Promise<InvoiceDetailRow[]> {
    const body = await this.post(INV_SERV_PATH, {
      version: '1.0',
      action: 'carrierInvDetail',
      ...this.carrierParams(),
      invNum: header.invNum,
      invDate: toApiDate(header.invDate),
      amount: String(header.amount),
      sellerName: header.sellerName ?? '',
      sellerBan: header.sellerBan ?? '',
    });
    return parseDetails(body);
  }

  async qryWinningList(invPeriod: string): Promise<WinningNumbers> {
    // Public endpoint: no carrier credentials, which is why it is the cheapest
    // possible proof that the App ID and the transport work at all.
    const body = await this.post(INV_APP_PATH, {
      version: '0.2',
      action: 'qryWinningList',
      invTerm: invPeriod,
      UUID: this.uuid,
      appID: this.appId,
    });
    return parseWinningNumbers(body, invPeriod);
  }

  // ------------------------------------------------------------- internals

  /**
   * Auth and timestamp params. Regenerated per call — and, crucially, per
   * retry attempt — because the server rejects a `timeStamp` too far from its
   * own clock, and a reused one would make a retry of a slow request fail for
   * a reason unrelated to the original failure.
   */
  private carrierParams(): Record<string, string> {
    return {
      cardType: this.credentials.cardType,
      cardNo: this.credentials.cardNo,
      cardEncrypt: this.credentials.cardEncrypt,
      uuid: this.uuid,
      appID: this.appId,
    };
  }

  private timestamps(): Record<string, string> {
    const seconds = Math.floor(this.now() / 1000);
    return {
      timeStamp: String(seconds),
      expTimeStamp: String(seconds + EXPIRY_SECONDS),
    };
  }

  private async post(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        // Timestamps inside the loop: see the comment on carrierParams().
        const form = new URLSearchParams({ ...params, ...this.timestamps() });
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });

        if (!response.ok) {
          throw new TransportError(`HTTP ${response.status}`, response.status);
        }

        const text = await response.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new TransportError(`response was not JSON: ${truncate(text, 200)}`, response.status);
        }

        // Throws EInvoiceError / QuotaError on a non-OK body code. An HTTP 200
        // does not mean success — the status lives in the body.
        return parseEnvelope(json);
      } catch (err) {
        lastError = err;

        // A quota error is a normal outcome, not a transient fault. Retrying
        // it burns the remaining budget for nothing.
        if (err instanceof QuotaError) throw this.scrubError(err);
        // An application-level rejection (bad date range, wrong verification
        // code) will reject identically next time.
        if (err instanceof EInvoiceError) throw this.scrubError(err);

        if (attempt < this.maxAttempts) {
          await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
          continue;
        }
      }
    }

    throw this.scrubError(lastError);
  }

  /**
   * The scrubbing boundary. Nothing leaves this class carrying a credential,
   * whether it came from our own message, the server's, or a stack trace.
   */
  private scrubError(err: unknown): Error {
    const secrets = [this.credentials.cardNo, this.credentials.cardEncrypt];
    if (err instanceof QuotaError) return new QuotaError(err.code, scrub(err.message, secrets));
    if (err instanceof EInvoiceError) return new EInvoiceError(err.code, scrub(err.message, secrets));
    if (err instanceof TransportError) {
      return new TransportError(scrub(err.message, secrets), err.status);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new TransportError(scrub(message, secrets));
  }
}

/**
 * Replace every occurrence of a secret with a marker. Exported because the
 * sync writes `sync_run.error` and the API layer writes error responses, and
 * both need the same guarantee — but note that the client already scrubs
 * everything it throws, so this is a second belt, not the only one.
 */
export function scrub(text: string, secrets: (string | undefined | null)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  // Also catch a credential that arrived inside an echoed query string, where
  // it may be percent-encoded or spelled by parameter name rather than value.
  out = out.replace(/(card(?:No|Encrypt)=)[^&\s"']*/gi, '$1[redacted]');
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
