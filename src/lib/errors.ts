/**
 * Error taxonomy for the MOF client.
 *
 * The distinction that matters to the sync is quota vs everything else: a
 * quota error is a normal outcome that ends a run cleanly (`status = 'quota'`,
 * work committed, continue tomorrow), never an exception that loses progress.
 */

export class EInvoiceError extends Error {
  /** Status code from the JSON body — HTTP 200 does not mean success. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EInvoiceError';
    this.code = code;
  }
}

/** Rate limit or daily quota. The run stops here and resumes tomorrow. */
export class QuotaError extends EInvoiceError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'QuotaError';
  }
}

/** Network failure, non-2xx HTTP, or an unparseable body. */
export class TransportError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
  }
}

export function isQuotaError(err: unknown): err is QuotaError {
  return err instanceof QuotaError;
}
