/**
 * Passwords and sessions. Sign-up and sign-in are in accounts.test.ts.
 *
 * These tests run in Node, which imposes no PBKDF2 iteration limit — so a
 * round-trip test passes happily with a hash the deployed Worker rejects.
 * That is exactly how a 210,000-iteration hash reached production and turned
 * every login into a 500. The constant itself is therefore asserted, because
 * that is the only part of the constraint a Node-hosted test can see.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createSession,
  hashPassword,
  MAX_PBKDF2_ITERATIONS,
  verifyPassword,
  verifySession,
} from '../src/api/auth.js';
import { ApiError } from '../src/api/respond.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('the PBKDF2 iteration cap', () => {
  it('never exceeds what the Workers runtime supports', () => {
    // Raising this ships a hash that verifies locally and 500s in production.
    expect(MAX_PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000);
  });

  it('is what hashPassword defaults to', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored.split('$')[1]).toBe(String(MAX_PBKDF2_ITERATIONS));
  });

  it('is what the hash-password script emits', () => {
    // The script is a separate file with its own constant; the two drifting
    // apart is the failure this guards against.
    const out = execFileSync(
      process.execPath,
      [join(here, '..', 'scripts', 'hash-password.mjs'), 'some password'],
      { encoding: 'utf8' },
    ).trim();
    expect(out.split('$')[1]).toBe(String(MAX_PBKDF2_ITERATIONS));
  });

  it('rejects a stored hash above the cap with an actionable error', async () => {
    const overCap = await hashPassword('pw', MAX_PBKDF2_ITERATIONS + 1);
    await expect(verifyPassword('pw', overCap)).rejects.toThrow(ApiError);
    await expect(verifyPassword('pw', overCap)).rejects.toThrow(/hash-password/);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', stored)).toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    // The last three are what a truncated paste, or a shell that ate the
    // dollar separators, actually produces. Before this, they threw.
    const malformed = [
      '',
      'nonsense',
      'bcrypt$1$a$b',
      'pbkdf2$0$a$b',
      'pbkdf2$1000$!!$??',
      'pbkdf2$1000$$',
    ];
    for (const bad of malformed) {
      expect(await verifyPassword('pw', bad)).toBe(false);
    }
  });

  it('produces a different hash each time for the same password', async () => {
    // Random salt: the same password twice must not produce the same hash.
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('sessions', () => {
  const secret = 'a-test-signing-secret-long-enough';
  const now = 1_780_000_000;

  it('accepts a token it just issued, and says whose it is', async () => {
    expect(await verifySession(secret, await createSession(secret, 7, now), now)).toBe(7);
  });

  it('rejects a token signed with a different secret', async () => {
    // Rotating SESSION_SECRET is the documented way to sign everyone out.
    const token = await createSession(secret, 7, now);
    expect(await verifySession('a-different-secret-entirely', token, now)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await createSession(secret, 7, now);
    expect(await verifySession(secret, token, now + 60 * 60 * 24 * 365)).toBeNull();
  });

  it('rejects a tampered expiry', async () => {
    // The signature covers the expiry, so extending it invalidates the token.
    const token = await createSession(secret, 7, now);
    const signature = token.slice(token.lastIndexOf('.') + 1);
    const forged = `7.${now + 60 * 60 * 24 * 3650}.${signature}`;
    expect(await verifySession(secret, forged, now)).toBeNull();
  });

  it('rejects a token whose account id was changed', async () => {
    // The first thing anyone holding a valid cookie of their own would try.
    const token = await createSession(secret, 7, now);
    const forged = token.replace(/^7\./, '1.');
    expect(forged).not.toBe(token);
    expect(await verifySession(secret, forged, now)).toBeNull();
  });

  it('rejects a token from the single-user build, which carried no account', async () => {
    const [, expiry, signature] = (await createSession(secret, 7, now)).split('.');
    expect(await verifySession(secret, `${expiry}.${signature}`, now)).toBeNull();
  });

  it('rejects a missing or malformed token', async () => {
    expect(await verifySession(secret, null, now)).toBeNull();
    expect(await verifySession(secret, 'no-dot-here', now)).toBeNull();
    expect(await verifySession(secret, 'a.b.c', now)).toBeNull();
  });
});
