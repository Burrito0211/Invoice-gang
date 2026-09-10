/**
 * Owner auth. One user, no user table.
 *
 * `POST /api/login` compares a password against `OWNER_PASSWORD_HASH` and sets
 * an HttpOnly, Secure, SameSite=Strict cookie carrying an HMAC-signed expiry.
 * Every other route verifies it.
 *
 * There is no registration, no password reset and no session table: for one
 * user those are liabilities, not features. Rotating `SESSION_SECRET` logs you
 * out, which is the intended recovery path.
 *
 * The hash is PBKDF2-SHA256 rather than the argon2/scrypt named in the spec —
 * Workers ship WebCrypto and neither of those, and pulling in a WASM hasher
 * to protect a single self-chosen password is the worse trade. Format:
 * `pbkdf2$<iterations>$<salt b64>$<hash b64>`; `npm run hash-password` prints
 * one.
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
      `OWNER_PASSWORD_HASH uses ${iterations} iterations; this runtime supports at most ` +
        `${MAX_PBKDF2_ITERATIONS}. Regenerate it with "npm run hash-password" and set it again.`,
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

/** `<expiry unix seconds>.<hex HMAC of that string>`. No state on the server. */
export async function createSession(secret: string, now: Unix): Promise<string> {
  const expiry = String(now + SESSION_SECONDS);
  return `${expiry}.${await sign(secret, expiry)}`;
}

export async function verifySession(
  secret: string,
  token: string | null,
  now: Unix,
): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const expiry = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = await sign(secret, expiry);
  if (!timingSafeEqual(new TextEncoder().encode(signature), new TextEncoder().encode(expected))) {
    return false;
  }
  const expiresAt = Number(expiry);
  return Number.isFinite(expiresAt) && expiresAt > now;
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

/** Throws 401 unless the request carries a valid session. */
export async function requireOwner(request: Request, env: Env, now: Unix): Promise<void> {
  const ok = await verifySession(env.SESSION_SECRET, readSessionCookie(request), now);
  if (!ok) throw new ApiError(401, 'unauthorized', 'sign in first');
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
