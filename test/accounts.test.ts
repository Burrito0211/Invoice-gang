/**
 * Accounts — and the property that makes them worth having: one account can
 * never see or change another's data.
 *
 * Isolation is tested by importing the same export into two accounts, so that
 * every invoice number and item key exists twice. That is the case a missing
 * `account_id` filter gets wrong; with different data in each account, a
 * leaky query can still happen to return the right rows and pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importCarrierCsv } from '../src/import/run.js';
import {
  accountFromImportToken,
  handleAccount,
  handleCreateImportToken,
  handleDeleteImportToken,
  handleLogin,
  handleRegister,
  handleUpdateAccount,
} from '../src/api/account.js';
import { handleCreateOverride } from '../src/api/categorize.js';
import { handleInvoiceDetail } from '../src/api/invoices.js';
import { hashPassword, verifySession } from '../src/api/auth.js';
import {
  deleteIncome,
  existingInvoiceNumbers,
  getAccountByUsername,
  getEffectiveBudget,
  insertIncome,
  listIncome,
  listInvoices,
  setItemExcluded,
  totalsForRange,
  upsertBudget,
} from '../src/db/queries.js';
import { createTestDb, createTestKv, seedAccount } from './helpers/d1.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(join(here, 'fixtures', 'carrier-export.csv'), 'utf8');
const RULES_SQL = readFileSync(join(here, '..', 'src', 'db', 'rules-tw.sql'), 'utf8');

const SECRET = 'a-test-signing-secret-long-enough';
const NOW = 1_780_000_000;

let db: ReturnType<typeof createTestDb>;
let kv: ReturnType<typeof createTestKv>;

beforeEach(() => {
  db = createTestDb();
  kv = createTestKv();
});

afterEach(() => db.close());

const env = (legacyHash?: string) => ({
  DB: db,
  SESSION_SECRET: SECRET,
  OWNER_PASSWORD_HASH: legacyHash,
});

const post = (path: string, body: unknown) =>
  new Request(`https://x${path}`, { method: 'POST', body: JSON.stringify(body) });

/** The account id a sign-in response's cookie verifies to. */
async function sessionOf(response: Response): Promise<number | null> {
  const cookie = response.headers.get('set-cookie') ?? '';
  return verifySession(SECRET, cookie.match(/ig_session=([^;]+)/)?.[1] ?? null, NOW);
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('signing up', () => {
  it('creates the account and signs it straight in', async () => {
    const response = await handleRegister(
      post('/api/register', { username: 'Alice', password: 'correct horse' }),
      env(),
      true,
      NOW,
    );
    expect(response.status).toBe(201);

    const account = await getAccountByUsername(db, 'alice');
    expect(account).not.toBeNull();
    expect(await sessionOf(response)).toBe(account!.id);
    // A hash, never the password.
    expect(account!.password_hash).toMatch(/^pbkdf2\$/);
    expect(account!.password_hash).not.toContain('correct horse');
  });

  it('treats usernames case-insensitively, so one name cannot be taken twice', async () => {
    await handleRegister(post('/api/register', { username: 'alice', password: 'correct horse' }), env(), true, NOW);
    await expect(
      handleRegister(post('/api/register', { username: ' ALICE ', password: 'another password' }), env(), true, NOW),
    ).rejects.toMatchObject({ status: 409, code: 'username_taken' });
    expect(await count(`SELECT COUNT(*) AS n FROM account`)).toBe(1);
  });

  it('refuses a malformed username or a password outside the limits', async () => {
    const attempts = [
      { username: 'ab', password: 'long enough' },
      { username: 'has space', password: 'long enough' },
      { username: '-leading', password: 'long enough' },
      { username: 'x'.repeat(33), password: 'long enough' },
      { username: '中文名字', password: 'long enough' },
      { username: 'bob', password: 'short' },
      { username: 'bob', password: 'x'.repeat(257) },
      { username: 'bob' },
    ];
    for (const body of attempts) {
      await expect(handleRegister(post('/api/register', body), env(), true, NOW)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(await count(`SELECT COUNT(*) AS n FROM account`)).toBe(0);
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    await handleRegister(post('/api/register', { username: 'alice', password: 'correct horse' }), env(), true, NOW);
  });

  it('accepts the right password, whatever the username case', async () => {
    const response = await handleLogin(
      post('/api/login', { username: 'Alice', password: 'correct horse' }),
      env(),
      true,
      NOW,
    );
    expect(await sessionOf(response)).toBe((await getAccountByUsername(db, 'alice'))!.id);
  });

  it('answers a wrong password and an unknown username identically', async () => {
    for (const body of [
      { username: 'alice', password: 'wrong horse' },
      { username: 'nobody', password: 'correct horse' },
    ]) {
      await expect(handleLogin(post('/api/login', body), env(), true, NOW)).rejects.toMatchObject({
        status: 401,
        code: 'bad_credentials',
        message: 'wrong username or password',
      });
    }
  });
});

describe('the account migrated from a single-user install', () => {
  beforeEach(async () => {
    // What migration 005 leaves behind: an `owner` with no hash of its own.
    await seedAccount(db, NOW, 1, 'owner');
  });

  it('signs in against OWNER_PASSWORD_HASH once, then no longer needs it', async () => {
    const legacy = await hashPassword('the old password');
    const first = await handleLogin(
      post('/api/login', { username: 'owner', password: 'the old password' }),
      env(legacy),
      true,
      NOW,
    );
    expect(await sessionOf(first)).toBe(1);
    expect((await getAccountByUsername(db, 'owner'))?.password_hash).toBe(legacy);

    const later = await handleLogin(
      post('/api/login', { username: 'owner', password: 'the old password' }),
      env(undefined),
      true,
      NOW,
    );
    expect(await sessionOf(later)).toBe(1);
  });

  it('does not claim the hash on a wrong password', async () => {
    const legacy = await hashPassword('the old password');
    await expect(
      handleLogin(post('/api/login', { username: 'owner', password: 'a guess' }), env(legacy), true, NOW),
    ).rejects.toMatchObject({ status: 401 });
    expect((await getAccountByUsername(db, 'owner'))?.password_hash).toBeNull();
  });

  it('cannot be entered at all while there is no legacy hash to check against', async () => {
    for (const password of ['', 'anything at all']) {
      await expect(
        handleLogin(post('/api/login', { username: 'owner', password }), env(undefined), true, NOW),
      ).rejects.toMatchObject({ status: 401 });
    }
  });
});

describe('import tokens', () => {
  const bearer = (token: string) =>
    new Request('https://x/api/import', { method: 'POST', headers: { authorization: `Bearer ${token}` } });

  const create = async (accountId: number) =>
    ((await (await handleCreateImportToken(db, accountId, NOW)).json()) as { token: string }).token;

  beforeEach(async () => {
    await seedAccount(db, NOW, 1);
    await seedAccount(db, NOW, 2);
  });

  it('authenticate as the account that created them, and no other', async () => {
    const one = await create(1);
    const two = await create(2);
    expect(await accountFromImportToken(bearer(one), db, NOW)).toBe(1);
    expect(await accountFromImportToken(bearer(two), db, NOW)).toBe(2);
    expect(await accountFromImportToken(bearer('f'.repeat(64)), db, NOW)).toBeNull();
    expect(await accountFromImportToken(bearer('not-a-token'), db, NOW)).toBeNull();
  });

  it('are stored only as a hash', async () => {
    const token = await create(1);
    const row = await db
      .prepare(`SELECT token_hash FROM import_token WHERE account_id = 1`)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toBe(token);
  });

  it('stop working the moment they are replaced or revoked', async () => {
    const first = await create(1);
    const second = await create(1);
    expect(await accountFromImportToken(bearer(first), db, NOW)).toBeNull();
    expect(await accountFromImportToken(bearer(second), db, NOW)).toBe(1);

    await handleDeleteImportToken(db, 1);
    expect(await accountFromImportToken(bearer(second), db, NOW)).toBeNull();
  });

  it('never come back out of the account endpoint, and nor does the password hash', async () => {
    const token = await create(1);
    const body = JSON.stringify(await (await handleAccount(db, 1)).json());
    expect(body).not.toContain(token);
    expect(body).not.toContain('password_hash');
    expect(body).toContain('"import_token":{');
  });
});

describe('the notification webhook', () => {
  beforeEach(() => seedAccount(db, NOW, 1));

  const put = (value: unknown) =>
    new Request('https://x/api/account', { method: 'PUT', body: JSON.stringify({ notify_webhook: value }) });

  it('takes an https URL, and null clears it', async () => {
    const set = (await (await handleUpdateAccount(db, 1, put('https://ntfy.sh/my-topic'))).json()) as {
      notify_webhook: string | null;
    };
    expect(set.notify_webhook).toBe('https://ntfy.sh/my-topic');

    const cleared = (await (await handleUpdateAccount(db, 1, put(null))).json()) as {
      notify_webhook: string | null;
    };
    expect(cleared.notify_webhook).toBeNull();
  });

  it('refuses anything that is not https', async () => {
    for (const value of ['http://ntfy.sh/x', 'not a url', 'javascript:alert(1)', 42]) {
      await expect(handleUpdateAccount(db, 1, put(value))).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe('isolation between accounts', () => {
  const FROM = '2026-09-01';
  const TO = '2026-09-30';

  beforeEach(async () => {
    await db.exec(RULES_SQL);
    await seedAccount(db, NOW, 1);
    await seedAccount(db, NOW, 2);
    let t = NOW;
    const deps = { db, kv, now: () => (t += 1), llm: null };
    await importCarrierCsv(CSV, deps, { accountId: 1, carrierId: 1, trigger: 'manual' });
    await importCarrierCsv(CSV, deps, { accountId: 2, carrierId: 2, trigger: 'manual' });
  });

  const spent = async (accountId: number) =>
    (await totalsForRange(db, accountId, FROM, TO))!.invoice_total;

  it('gives each account its own copy of the same export', async () => {
    expect(await count(`SELECT COUNT(*) AS n FROM invoice WHERE account_id = ?`, 1)).toBe(4);
    expect(await count(`SELECT COUNT(*) AS n FROM invoice WHERE account_id = ?`, 2)).toBe(4);
    expect(await count(`SELECT COUNT(*) AS n FROM invoice_item WHERE account_id = ?`, 2)).toBe(9);
    // Each total counts its own items once, not both accounts' together.
    expect(await spent(1)).toBe(await spent(2));
    expect(await spent(1)).toBeGreaterThan(0);
  });

  it('stays idempotent within an account when another holds the same invoices', async () => {
    let t = NOW + 1000;
    const again = await importCarrierCsv(
      CSV,
      { db, kv, now: () => (t += 1), llm: null },
      { accountId: 2, carrierId: 2, trigger: 'manual' },
    );
    expect(again.run.headers_new).toBe(0);
    expect(again.run.items_new).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM invoice`)).toBe(8);
  });

  it('never reports another account’s invoice as already imported', async () => {
    await seedAccount(db, NOW, 3);
    expect((await existingInvoiceNumbers(db, 3, ['EX31020263'])).size).toBe(0);
    expect((await existingInvoiceNumbers(db, 1, ['EX31020263'])).size).toBe(1);
  });

  it('lists and opens only the account’s own invoices', async () => {
    await seedAccount(db, NOW, 3);
    expect(await listInvoices(db, 3, { limit: 100 })).toEqual([]);
    expect((await listInvoices(db, 2, { limit: 100 })).every((i) => i.account_id === 2)).toBe(true);
    await expect(handleInvoiceDetail(db, 3, 'EX31020263')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps an item excluded by one account in the other account’s total', async () => {
    const before = await spent(2);
    const item = await db
      .prepare(`SELECT id, COALESCE(net_amount, amount) AS net FROM invoice_item
                WHERE account_id = 1 AND amount > 0 LIMIT 1`)
      .first<{ id: number; net: number }>();

    // Account 2 cannot touch account 1's row by id.
    expect(await setItemExcluded(db, 2, item!.id, true)).toBe(false);

    expect(await setItemExcluded(db, 1, item!.id, true)).toBe(true);
    expect(await spent(1)).toBe(before - item!.net);
    expect(await spent(2)).toBe(before);
  });

  it('applies a category correction only to the account that made it', async () => {
    const itemKey = (await db
      .prepare(`SELECT item_key FROM invoice_item WHERE account_id = 1 AND amount > 0 LIMIT 1`)
      .first<{ item_key: string }>())!.item_key;
    const request = new Request('https://x/api/categorize', {
      method: 'POST',
      body: JSON.stringify({ scope: 'item', key: itemKey, category: 'electronics' }),
    });

    const response = (await (await handleCreateOverride(db, 1, request, NOW)).json()) as {
      items_updated: number;
    };
    expect(response.items_updated).toBeGreaterThan(0);

    const overridden = await count(
      `SELECT COUNT(*) AS n FROM invoice_item WHERE account_id = ? AND category_source = 'override'`,
      2,
    );
    expect(overridden).toBe(0);
  });

  it('keeps income and budgets per account', async () => {
    const id = await insertIncome(db, 1, { date: '2026-09-15', amount: 45000, source: '薪資', note: null, now: NOW });
    expect(await listIncome(db, 2, FROM, TO)).toEqual([]);
    expect(await deleteIncome(db, 2, id)).toBe(false);
    expect((await listIncome(db, 1, FROM, TO)).length).toBe(1);

    await upsertBudget(db, 1, { month: '2026-09', amount: 20000, now: NOW });
    expect(await getEffectiveBudget(db, 2, '2026-09')).toBeNull();
    // Two accounts can each budget the same month.
    await upsertBudget(db, 2, { month: '2026-09', amount: 9000, now: NOW });
    expect((await getEffectiveBudget(db, 1, '2026-09'))?.amount).toBe(20000);
  });
});
