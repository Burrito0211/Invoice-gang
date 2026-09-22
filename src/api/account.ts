/**
 * Accounts: sign-up, sign-in, and the settings an account owns.
 *
 * Sign-up is open — anyone who reaches the site can register — so everything
 * here assumes the person on the other end is a stranger. That is why the
 * username rule is strict, why a password has a ceiling as well as a floor
 * (PBKDF2 over a megabyte of "password" is a CPU bill, not security), and why
 * signing in as a username that does not exist still pays for a hash, so the
 * response time does not say which usernames are real. Sign-up does reveal
 * that a name is taken; a registration form cannot avoid that.
 */
import {
  accountForImportToken,
  claimPasswordHash,
  deleteImportToken,
  getAccountById,
  getAccountByUsername,
  getImportToken,
  insertAccount,
  setNotifyWebhook,
  upsertImportToken,
} from '../db/queries.js';
import {
  createSession,
  hashPassword,
  randomToken,
  sessionCookie,
  sha256Hex,
  verifyPassword,
} from './auth.js';
import { ApiError, badRequest, json } from './respond.js';
import { readBody } from './categorize.js';
import type { Env, Unix } from '../types.js';

type AuthEnv = Pick<Env, 'DB' | 'SESSION_SECRET' | 'OWNER_PASSWORD_HASH'>;

/** Lowercase letters, digits and `_ . -`, 3–32 long, starting with a letter or digit. */
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const MAX_WEBHOOK = 2048;

// ------------------------------------------------------------ sign up / in

/** `POST /api/register { username, password }` — creates the account and signs it in. */
export async function handleRegister(
  request: Request,
  env: AuthEnv,
  secure: boolean,
  now: Unix,
): Promise<Response> {
  const { username, password } = await readCredentials(request);
  if (!USERNAME.test(username)) {
    throw badRequest('username must be 3–32 characters: lowercase letters, digits, _ . -');
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw badRequest(`password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters`);
  }

  const id = await insertAccount(env.DB, {
    username,
    passwordHash: await hashPassword(password),
    now,
  });
  if (id === null) throw new ApiError(409, 'username_taken', 'that username is taken');
  return signedIn(env, id, username, secure, now, 201);
}

/** `POST /api/login { username, password }`. */
export async function handleLogin(
  request: Request,
  env: AuthEnv,
  secure: boolean,
  now: Unix,
): Promise<Response> {
  const { username, password } = await readCredentials(request);
  const account =
    password.length <= MAX_PASSWORD ? await getAccountByUsername(env.DB, username) : null;

  if (account === null) {
    await verifyPassword(password.slice(0, MAX_PASSWORD), await decoyHash());
    throw badCredentials();
  }
  if (!(await passwordMatches(env, account.id, account.password_hash, password))) {
    throw badCredentials();
  }
  return signedIn(env, account.id, account.username, secure, now, 200);
}

/**
 * The account migration 005 made from a single-user install has no hash of
 * its own. Its first sign-in is checked against `OWNER_PASSWORD_HASH` and,
 * when it matches, that hash is copied into the row — so the secret stops
 * mattering after one successful sign-in, and an unset secret means the
 * account cannot be entered at all rather than being entered with anything.
 */
async function passwordMatches(
  env: AuthEnv,
  accountId: number,
  stored: string | null,
  password: string,
): Promise<boolean> {
  if (stored !== null) return verifyPassword(password, stored);

  const legacy = env.OWNER_PASSWORD_HASH;
  if (typeof legacy !== 'string' || legacy === '') return false;
  if (!(await verifyPassword(password, legacy))) return false;
  await claimPasswordHash(env.DB, accountId, legacy);
  return true;
}

let decoy: Promise<string> | undefined;

/** A real hash of a random password, made once per isolate, to verify unknown usernames against. */
function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomToken());
  return decoy;
}

async function readCredentials(request: Request): Promise<{ username: string; password: string }> {
  const body = ((await readBody(request)) ?? {}) as { username?: unknown; password?: unknown };
  return {
    // Stored lowercase, so `Alice` and `alice` are one account, not two.
    username: typeof body.username === 'string' ? body.username.trim().toLowerCase() : '',
    password: typeof body.password === 'string' ? body.password : '',
  };
}

async function signedIn(
  env: AuthEnv,
  accountId: number,
  username: string,
  secure: boolean,
  now: Unix,
  status: number,
): Promise<Response> {
  const token = await createSession(env.SESSION_SECRET, accountId, now);
  return json({ ok: true, username }, status, { 'set-cookie': sessionCookie(token, secure) });
}

/** One message for a wrong password and an unknown username alike. */
function badCredentials(): ApiError {
  return new ApiError(401, 'bad_credentials', 'wrong username or password');
}

// ---------------------------------------------------------------- settings

/** `GET /api/account`. Never carries the password hash or the import token itself. */
export async function handleAccount(db: D1Database, accountId: number): Promise<Response> {
  return json(await describeAccount(db, accountId));
}

/** `PUT /api/account { notify_webhook }` — answers with the same shape as the GET. */
export async function handleUpdateAccount(
  db: D1Database,
  accountId: number,
  request: Request,
): Promise<Response> {
  const body = ((await readBody(request)) ?? {}) as { notify_webhook?: unknown };
  if (body.notify_webhook === undefined) throw badRequest('nothing to update');

  await setNotifyWebhook(db, accountId, parseWebhook(body.notify_webhook));
  return json(await describeAccount(db, accountId));
}

/**
 * `null` or an empty string clears it; anything else must be an https URL.
 * The cron POSTs how stale this account's spending is and which of its
 * invoices won, and that is not something to send in the clear.
 */
function parseWebhook(value: unknown): string | null {
  if (value === null || value === '') return null;
  const invalid = () => badRequest('notify_webhook must be an https URL');
  if (typeof value !== 'string' || value.length > MAX_WEBHOOK) throw invalid();

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:') throw invalid();
  return url.href;
}

async function describeAccount(db: D1Database, accountId: number) {
  const account = await getAccountById(db, accountId);
  // A validly signed session for an account that is not in this database.
  if (!account) throw new ApiError(401, 'unauthorized', 'sign in first');

  const token = await getImportToken(db, accountId);
  return {
    username: account.username,
    created_at: account.created_at,
    notify_webhook: account.notify_webhook,
    import_token:
      token === null ? null : { created_at: token.created_at, last_used_at: token.last_used_at },
  };
}

// ------------------------------------------------------------ import token

/**
 * `POST /api/account/import-token`. The token is in this response and nowhere
 * else, ever — the table keeps only its hash — so the dashboard shows it once.
 * Creating one replaces any existing token, which is also how a leaked one is
 * revoked.
 */
export async function handleCreateImportToken(
  db: D1Database,
  accountId: number,
  now: Unix,
): Promise<Response> {
  const token = randomToken();
  await upsertImportToken(db, accountId, await sha256Hex(token), now);
  return json({ token, created_at: now }, 201);
}

/** `DELETE /api/account/import-token`. Idempotent: revoking nothing is not an error. */
export async function handleDeleteImportToken(db: D1Database, accountId: number): Promise<Response> {
  await deleteImportToken(db, accountId);
  return json({ ok: true });
}

/**
 * The account a watch-folder upload belongs to, from its bearer token — or
 * `null` when there is no token or it matches nothing, and the caller falls
 * back to the session cookie.
 */
export async function accountFromImportToken(
  request: Request,
  db: D1Database,
  now: Unix,
): Promise<number | null> {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1]?.toLowerCase();
  // Every token this issues is 64 hex characters; nothing else can match, so
  // anything else is not worth a hash and a query.
  if (token === undefined || !/^[0-9a-f]{64}$/.test(token)) return null;
  return accountForImportToken(db, await sha256Hex(token), now);
}
