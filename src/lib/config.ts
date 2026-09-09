/**
 * Configuration, validated once and loudly.
 *
 * Much smaller than it was: the overlap window, page size, header budget and
 * detail budget all described a paginated rate-limited API that no longer
 * exists. What remains is the one knob that still costs money.
 */
import type { Env } from '../types.js';

export interface Config {
  llmBatchSize: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Per-call batch size. Bigger is cheaper per item; 50 is the verified default. */
const DEFAULT_LLM_BATCH_SIZE = 50;

export function loadConfig(env: Env): Config {
  return {
    llmBatchSize: int(env.LLM_BATCH_SIZE, DEFAULT_LLM_BATCH_SIZE, 'LLM_BATCH_SIZE'),
  };
}

/**
 * Fail before anything is written rather than after, so a missing secret is
 * one clear error instead of a confusing downstream failure.
 */
export function requireAuthSecrets(env: Env): void {
  requireAll(env, ['SESSION_SECRET', 'OWNER_PASSWORD_HASH']);
}

export function requireLlmSecrets(env: Env): void {
  requireAll(env, ['ANTHROPIC_API_KEY']);
}

function requireAll(env: Env, keys: (keyof Env)[]): void {
  const missing = keys.filter((k) => {
    const value = env[k];
    return typeof value !== 'string' || value.length === 0;
  });
  if (missing.length > 0) {
    throw new ConfigError(
      `missing required secret(s): ${missing.join(', ')} — set them with \`wrangler secret put\``,
    );
  }
}

function int(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}
