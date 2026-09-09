/**
 * Configuration is validated once, loudly. None of these values are optional
 * at boot: a sync that runs with a missing credential does not fail, it
 * silently syncs nothing, which is the worst possible outcome for a job
 * nobody watches.
 */
import type { Env } from '../types.js';

export interface Config {
  overlapDays: number;
  windowDays: number;
  headerCallBudget: number;
  detailBudgetPerRun: number;
  llmBatchSize: number;
  baseUrl: string;
  uuid: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULTS: Config = {
  overlapDays: 7,
  windowDays: 30,
  headerCallBudget: 6,
  detailBudgetPerRun: 200,
  llmBatchSize: 50,
  baseUrl: 'https://api.einvoice.nat.gov.tw',
  uuid: 'invoice-gang',
};

export function loadConfig(env: Env): Config {
  return {
    overlapDays: int(env.SYNC_OVERLAP_DAYS, DEFAULTS.overlapDays, 'SYNC_OVERLAP_DAYS'),
    windowDays: int(env.SYNC_WINDOW_DAYS, DEFAULTS.windowDays, 'SYNC_WINDOW_DAYS'),
    headerCallBudget: int(
      env.SYNC_HEADER_CALL_BUDGET,
      DEFAULTS.headerCallBudget,
      'SYNC_HEADER_CALL_BUDGET',
    ),
    detailBudgetPerRun: int(
      env.DETAIL_BUDGET_PER_RUN,
      DEFAULTS.detailBudgetPerRun,
      'DETAIL_BUDGET_PER_RUN',
    ),
    llmBatchSize: int(env.LLM_BATCH_SIZE, DEFAULTS.llmBatchSize, 'LLM_BATCH_SIZE'),
    baseUrl: (env.EINVOICE_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    uuid: env.EINVOICE_UUID ?? DEFAULTS.uuid,
  };
}

/**
 * Fail before the first HTTP call rather than after it, so a missing secret
 * shows up as one clear `sync_run.error` instead of a confusing API rejection.
 */
export function requireSyncSecrets(env: Env): void {
  requireAll(env, ['EINVOICE_APP_ID', 'EINVOICE_CARD_NO', 'EINVOICE_CARD_ENCRYPT']);
}

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
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}
