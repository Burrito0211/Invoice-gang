/**
 * Prints an `OWNER_PASSWORD_HASH` for `wrangler secret put`.
 *
 *   node scripts/hash-password.mjs 'my password'
 *
 * PBKDF2-SHA256 via WebCrypto, the same primitive `src/api/auth.ts` verifies
 * with — Workers ship WebCrypto and neither argon2 nor scrypt, and pulling a
 * WASM hasher in to protect one self-chosen password is the worse trade.
 */
import { webcrypto as crypto } from 'node:crypto';

const ITERATIONS = 210_000;
const password = process.argv[2];

if (!password) {
  console.error("usage: node scripts/hash-password.mjs 'your password'");
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(password),
  'PBKDF2',
  false,
  ['deriveBits'],
);
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
  key,
  256,
);

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
console.log(`pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
