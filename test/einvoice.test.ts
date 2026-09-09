/**
 * The MOF boundary: response parsing, the body status code, and the one thing
 * that must never fail — credentials not leaking into an error.
 */
import { describe, expect, it, vi } from 'vitest';
import { EInvoiceClient, scrub } from '../src/einvoice/client.js';
import { parseDetails, parseEnvelope, parseHeaders } from '../src/einvoice/parse.js';
import { EInvoiceError, QuotaError } from '../src/lib/errors.js';

const CREDENTIALS = { cardType: '3J0002', cardNo: '/ABC+123', cardEncrypt: 'sup3rsecret' };

function client(fetchImpl: typeof fetch) {
  return new EInvoiceClient({
    baseUrl: 'https://api.example.invalid',
    appId: 'APP-ID',
    uuid: 'test',
    credentials: CREDENTIALS,
    fetchImpl,
    now: () => 1_750_000_000_000,
    maxAttempts: 2,
    retryBaseMs: 0,
    sleep: async () => {},
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('parseEnvelope', () => {
  it('accepts a body code of 200', () => {
    expect(parseEnvelope({ code: '200', details: [] })).toMatchObject({ code: '200' });
  });

  it('rejects a non-OK body code even though the HTTP status was 200', () => {
    expect(() => parseEnvelope({ code: '901', msg: '載具號碼錯誤' })).toThrow(EInvoiceError);
  });

  it('classifies a quota message as a quota error, not a failure', () => {
    expect(() => parseEnvelope({ code: '999', msg: '查詢次數超過限制' })).toThrow(QuotaError);
    expect(() => parseEnvelope({ code: '429', msg: 'slow down' })).toThrow(QuotaError);
  });
});

describe('parseHeaders', () => {
  it('normalizes the API date form to YYYY-MM-DD', () => {
    const [header] = parseHeaders({
      details: [
        {
          invNum: 'ab12345678',
          invDate: '2026/09/03',
          amount: '1,250.00',
          sellerName: '統一超商',
          sellerBan: '12345678',
        },
      ],
    });
    expect(header).toMatchObject({
      invNum: 'AB12345678',
      invDate: '2026-09-03',
      amount: 1250,
    });
  });

  it('accepts the ROC date forms the API also emits', () => {
    expect(parseHeaders({ details: [{ invNum: 'A1', invDate: '1150903', amount: 1 }] })[0]?.invDate)
      .toBe('2026-09-03');
    expect(parseHeaders({ details: [{ invNum: 'A1', invDate: '115/09/03', amount: 1 }] })[0]?.invDate)
      .toBe('2026-09-03');
  });

  it('tolerates the list arriving under a different key', () => {
    expect(parseHeaders({ invoices: [{ invNum: 'A1', invDate: '2026-01-01', amount: 5 }] })).toHaveLength(1);
  });

  it('skips rows with no identity rather than inventing one', () => {
    expect(parseHeaders({ details: [{ amount: 100 }, { invNum: 'A1' }] })).toHaveLength(0);
  });

  it('never lets a float reach an amount', () => {
    const [header] = parseHeaders({
      details: [{ invNum: 'A1', invDate: '2026-01-01', amount: '99.6' }],
    });
    expect(Number.isInteger(header?.amount)).toBe(true);
    expect(header?.amount).toBe(100);
  });
});

describe('parseDetails', () => {
  it('falls back to array position when rowNum is missing', () => {
    const rows = parseDetails({ details: [{ description: 'a', amount: 10 }, { description: 'b', amount: 20 }] });
    expect(rows.map((r) => r.rowNum)).toEqual([1, 2]);
  });

  it('drops rows with no description, which carry no information', () => {
    expect(parseDetails({ details: [{ amount: 10 }] })).toHaveLength(0);
  });
});

describe('credential scrubbing', () => {
  it('removes the card number and verification code from any message', () => {
    const text = 'auth failed for cardNo=/ABC+123 with sup3rsecret';
    const scrubbed = scrub(text, [CREDENTIALS.cardNo, CREDENTIALS.cardEncrypt]);
    expect(scrubbed).not.toContain('/ABC+123');
    expect(scrubbed).not.toContain('sup3rsecret');
  });

  it('redacts a credential echoed back inside a query string', () => {
    const scrubbed = scrub('rejected: cardEncrypt=whatever&action=carrierInvChk', []);
    expect(scrubbed).toContain('cardEncrypt=[redacted]');
    expect(scrubbed).toContain('action=carrierInvChk');
  });

  it('scrubs errors the server echoes credentials into', async () => {
    // This is the case that matters: the API rejects the call and quotes the
    // credential back at us, and that message is on its way to sync_run.error.
    const api = client(async () =>
      jsonResponse({ code: '901', msg: `invalid carrier ${CREDENTIALS.cardNo} / ${CREDENTIALS.cardEncrypt}` }),
    );

    const error = await api
      .carrierInvChk({ start: '2026-09-01', end: '2026-09-02' })
      .then(() => null)
      .catch((err: Error) => err);

    expect(error).toBeInstanceOf(EInvoiceError);
    expect(error?.message).toContain('[redacted]');
    expect(error?.message).not.toContain(CREDENTIALS.cardNo);
    expect(error?.message).not.toContain(CREDENTIALS.cardEncrypt);
  });
});

describe('transport', () => {
  it('regenerates the timestamp on every attempt', async () => {
    // Reusing a timestamp across a retry makes the retry fail for a reason
    // unrelated to the original failure.
    const seen: string[] = [];
    let now = 1_750_000_000_000;
    const api = new EInvoiceClient({
      baseUrl: 'https://api.example.invalid',
      appId: 'APP-ID',
      uuid: 'test',
      credentials: CREDENTIALS,
      now: () => (now += 5_000),
      maxAttempts: 3,
      retryBaseMs: 0,
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        const body = new URLSearchParams(String((init as RequestInit).body));
        seen.push(body.get('timeStamp') ?? '');
        if (seen.length < 3) throw new Error('connection reset');
        return jsonResponse({ code: '200', details: [] });
      },
    });

    await api.carrierInvChk({ start: '2026-09-01', end: '2026-09-02' });
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('does not retry a quota error — it would burn the remaining budget', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: '904', msg: '查詢次數超過限制' }));
    const api = client(fetchImpl as unknown as typeof fetch);

    await expect(api.carrierInvChk({ start: '2026-09-01', end: '2026-09-02' })).rejects.toThrow(
      QuotaError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends the API date form, not the internal one', async () => {
    let sent = '';
    const api = client(async (_url, init) => {
      sent = String((init as RequestInit).body);
      return jsonResponse({ code: '200', details: [] });
    });

    await api.carrierInvChk({ start: '2026-09-01', end: '2026-09-30' });
    const body = new URLSearchParams(sent);
    expect(body.get('startDate')).toBe('2026/09/01');
    expect(body.get('endDate')).toBe('2026/09/30');
    expect(body.get('action')).toBe('carrierInvChk');
  });
});
