import type { Channel } from '../contracts/index.js';
import { profiles, type Profile } from '../profiles/index.js';

type Env = Record<string, string | undefined>;
const channels: Channel[] = ['web', 'whatsapp', 'call-center'];

function numeric(env: Env, key: string, fallback: number, min: number, max: number) {
  const raw = env[key];
  const value = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Configuración inválida (${key})`);
  return value;
}
function flag(env: Env, key: string) {
  const value = env[key] ?? 'false';
  if (value !== 'true' && value !== 'false') throw new Error(`Configuración inválida (${key})`);
  return value === 'true';
}
function endpoint(raw: string, key: string) {
  const url = URL.parse(raw);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !['/', '/api/v1', '/api/v1/'].includes(url.pathname)) {
    throw new Error(`Configuración inválida (${key})`);
  }
  return url.origin;
}
function webInterface(raw: string | undefined, key: string): string | undefined {
  if (!raw) return undefined;
  const url = URL.parse(raw);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.protocol !== 'https:' && !isLoopback(url.origin))) {
    throw new Error('Configuración inválida (' + key + ')');
  }
  return url.href;
}
export function isLoopback(origin: string) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
}
function weights(raw?: string): Record<Profile, number> {
  const entries = Object.entries(profiles).map(([name, profile]) => [name, profile.weight]);
  const result = Object.fromEntries(entries) as Record<Profile, number>;
  if (raw === undefined) return result;
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw new Error('SIM_PROFILE_WEIGHTS inválido'); }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('SIM_PROFILE_WEIGHTS inválido');
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(profiles, name) || typeof value !== 'number' || !Number.isInteger(value) ||
        value < 0 || value > 10_000 || (name === 'resultados' && value > 0)) {
      throw new Error('SIM_PROFILE_WEIGHTS inválido o capacidad ausente');
    }
    result[name as Profile] = value;
  }
  if (!Object.values(result).some(Boolean)) throw new Error('SIM_PROFILE_WEIGHTS vacío');
  return result;
}
export function frustrationMode(raw?: string): 'observed' | 'initial' {
  const value = raw ?? 'observed';
  if (value !== 'initial' && value !== 'observed') throw new Error('SIM_FRUSTRATION_MODE inválido');
  return value;
}
export function readConfig(env: Env = process.env) {
  const environment = env.SIM_ENV ?? 'local';
  if (environment !== 'local' && environment !== 'test') throw new Error('SIM_ENV inválido');
  const central = endpoint(env.SIM_CENTRAL_URL ?? 'http://127.0.0.1:3000', 'SIM_CENTRAL_URL');
  const orchestrator = endpoint(env.SIM_ORCHESTRATOR_URL ?? 'http://127.0.0.1:3300', 'SIM_ORCHESTRATOR_URL');
  const enabledChannels = (env.SIM_CHANNELS ?? channels.join(',')).split(',').map(value => value.trim() as Channel);
  if (!enabledChannels.every(channel => channels.includes(channel)) ||
      new Set(enabledChannels).size !== enabledChannels.length) throw new Error('SIM_CHANNELS inválido');
  return {
    environment, central, orchestrator, enabledChannels,
    interfaces: {
      patientPortal: webInterface(env.SIM_PATIENT_PORTAL_URL, 'SIM_PATIENT_PORTAL_URL'),
      callCenter: webInterface(env.SIM_CALL_CENTER_URL, 'SIM_CALL_CENTER_URL'),
      administration: webInterface(env.SIM_ADMIN_URL, 'SIM_ADMIN_URL'),
    },
    allowWrites: flag(env, 'SIM_ALLOW_WRITES'),
    capabilities: { conversation: flag(env, 'SIM_CONVERSATION'), continuity: flag(env, 'SIM_CONTINUITY'),
      results: false as const },
    seed: numeric(env, 'SIM_SEED', 42, 0, 0xffffffff),
    records: numeric(env, 'SIM_RECORDS', 10_000, 1, 5_000_000),
    virtualUsers: numeric(env, 'SIM_VUS', 5, 1, 10_000),
    rate: numeric(env, 'SIM_RATE', 5, 1, 100_000),
    durationSeconds: numeric(env, 'SIM_DURATION_SECONDS', 60, 1, 86_400),
    concurrency: numeric(env, 'SIM_CONCURRENCY', 2, 1, 100),
    timeoutMs: numeric(env, 'SIM_TIMEOUT_MS', 8_000, 1, 120_000),
    retries: numeric(env, 'SIM_READ_RETRIES', 1, 0, 3),
    maxRetryAfterMs: numeric(env, 'SIM_MAX_RETRY_AFTER_MS', 5_000, 0, 60_000),
    thresholds: { p95Ms: numeric(env, 'SIM_P95_MS', 500, 1, 120_000),
      errorPercent: numeric(env, 'SIM_ERROR_PERCENT', 1, 0, 100) },
    frustrationMode: frustrationMode(env.SIM_FRUSTRATION_MODE),
    frustration: { initial: numeric(env, 'SIM_FRUSTRATION_INITIAL', 20, 0, 100),
      retryBudget: numeric(env, 'SIM_FRUSTRATION_RETRIES', 2, 0, 5) },
    weights: weights(env.SIM_PROFILE_WEIGHTS),
  };
}
export type Config = ReturnType<typeof readConfig>;
