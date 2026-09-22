/**
 * Passwords and sessions — the cryptography under accounts.
 *
 * Sign-up and sign-in themselves are in `account.ts`. A session is an
 * HttpOnly, SameSite=Strict cookie carrying an account id and an expiry,
 * HMAC-signed with `SESSION_SECRET`. There is still no session table:
 * verifying a cookie costs no database read, and rotating the secret signs
 * every account out, which remains the recovery path.
 *
 * The hash is PBKDF2-SHA256 rather than argon2 or scrypt — Workers ship
 * WebCrypto and neither of those, and a WASM hasher is more to trust and to
 * ship than the problem needs. Format: `pbkdf2$<iterations>$<salt b64>$<hash
 * b64>`, which is what the `account.password_hash` column holds.
 *
 * **The Workers runtime rejects PBKDF2 above 100,000 iterations.** Node has no
 * such limit, so a hash generated with more verifies fine locally and throws
 * only once deployed — which is exactly how it shipped broken once. The cap is
 * enforced on both sides now.
 */
import { ApiError } from './respond.js';
import type { Env, Unix } from '../types.js';

const COOKIE_NAME = 'ig_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const PBKDF2_HASH = 'SHA-256';
const KEY_BITS = 256;

/** A hard limit of the Workers runtime, not a tuning preference. */
export const MAX_PBKDF2_ITERATIONS = 100_000;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  // Say what is wrong and how to fix it, rather than letting WebCrypto throw a
  // NotSupportedError that reaches the user as a bare 500.
  if (iterations > MAX_PBKDF2_ITERATIONS) {
    throw new ApiError(
      500,
      'bad_password_hash',
      `a stored password hash uses ${iterations} iterations; this runtime supports at most ` +
        `${MAX_PBKDF2_ITERATIONS}. Regenerate it with "npm run hash-password" and store it again.`,
    );
  }

  // Decoded only after validation, and defensively: a truncated paste or a
  // shell that ate the `$` separators must fail the login, not crash it.
  const salt = fromBase64(parts[2] ?? '');
  const expected = fromBase64(parts[3] ?? '');
  if (salt === null || expected === null || salt.length === 0 || expected.length === 0) {
    return false;
  }

  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

export async function hashPassword(
  password: string,
  iterations = MAX_PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------- sessions

/** `<account id>.<expiry unix seconds>.<hex HMAC of the first two>`. No server state. */
export async function createSession(secret: string, accountId: number, now: Unix): Promise<string> {
  const payload = `${accountId}.${now + SESSION_SECONDS}`;
  return `${payload}.${await sign(secret, payload)}`;
}

/**
 * The account a token was issued to, or `null`. The signature covers the id
 * and the expiry together, so neither can be edited — and editing the id is
 * the first thing anyone with a valid cookie of their own would try. A token
 * from the single-user build has no id and is simply refused.
 */
export async function verifySession(
  secret: string,
  token: string | null,
  now: Unix,
): Promise<number | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id = '', expiry = '', signature = ''] = parts;
  if (!/^\d{1,15}$/.test(id) || !/^\d{1,15}$/.test(expiry)) return null;

  const expected = await sign(secret, `${id}.${expiry}`);
  if (!timingSafeEqual(new TextEncoder().encode(signature), new TextEncoder().encode(expected))) {
    return null;
  }
  if (Number(expiry) <= now) return null;

  const accountId = Number(id);
  return accountId > 0 ? accountId : null;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return toHex(new Uint8Array(mac));
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${SESSION_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

/** The signed-in account's id. Throws 401 unless the request carries a valid session. */
export async function requireAccount(request: Request, env: Env, now: Unix): Promise<number> {
  const accountId = await verifySession(env.SESSION_SECRET, readSessionCookie(request), now);
  if (accountId === null) throw new ApiError(401, 'unauthorized', 'sign in first');
  return accountId;
}

// ------------------------------------------------------------------ tokens

/** 256 random bits as hex — import tokens, and the decoy password in `account.ts`. */
export function randomToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

// ----------------------------------------------------------------- encoding

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `null` when the input is not valid base64 — `atob` throws on bad input. */
function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
