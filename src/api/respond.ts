/**
 * Response helpers.
 *
 * Errors are `{ error: { code, message } }` with a real HTTP status. `code` is
 * stable and machine-readable; `message` is for a human. Money is an integer
 * in every payload — the server never formats currency, the client does.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: { code: err.code, message: err.message } }, err.status);
  }
  // Nothing from the MOF client reaches here carrying a credential — it is
  // scrubbed where it is thrown — but an unexpected error still gets a
  // generic message rather than an internal one.
  console.error('unhandled API error', err);
  return json({ error: { code: 'internal', message: 'internal error' } }, 500);
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, 'bad_request', message);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, 'not_found', message);
}

// ------------------------------------------------------------- param parsing

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function optionalDate(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return undefined;
  if (!ISO_DATE.test(value)) throw badRequest(`${name} must be YYYY-MM-DD`);
  return value;
}

export function optionalString(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
}

export function boolParam(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  return value === 'true' || value === '1';
}

export function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`${name} must be a positive integer`);
  return Math.min(n, max);
}

/** Default range: the current month, in the caller's terms not the server's. */
export function dateRange(url: URL, today: string): { from: string; to: string } {
  const month = today.slice(0, 7);
  return {
    from: optionalDate(url, 'from') ?? `${month}-01`,
    to: optionalDate(url, 'to') ?? today,
  };
}
