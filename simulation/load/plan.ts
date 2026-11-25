export const arrivalLevels = [5, 10, 25, 50, 100, 250, 500, 1000] as const;
export const loadNames = ['smoke', 'habitual', 'progressive', 'peak', 'spike', 'saturation', 'soak', 'admin',
  'independent', 'version-conflict', 'idempotency', 'continuity', 'frustrated'] as const;
type LoadName = typeof loadNames[number];
export type Env = Record<string, string | undefined>;
const oneShot = new Set<LoadName>(['version-conflict', 'idempotency', 'continuity', 'frustrated']);
const mode = (env: Env): 'initial' | 'observed' => {
  const value = env.SIM_FRUSTRATION_MODE ?? 'observed';
  if (value !== 'initial' && value !== 'observed') throw new Error('SIM_FRUSTRATION_MODE inválido');
  return value;
};
const writes = new Set<LoadName>([...oneShot, 'independent']);

function number(env: Env, key: string, fallback: number, min: number, max: number) {
  const input = env[key];
  const value = input === undefined ? fallback : /^\d+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Configuración inválida: ' + key);
  return value;
}
export function readLoadPlan(env: Env) {
  const candidate = env.SIM_LOAD_SCENARIO ?? 'smoke';
  if (!loadNames.includes(candidate as LoadName)) throw new Error('Escenario k6 desconocido');
  const name = candidate as LoadName;
  const rate = number(env, 'SIM_RATE', 10, 1, 1000);
  const seconds = number(env, 'SIM_DURATION_SECONDS', name === 'soak' ? 900 : 30, 1, 7200);
  const ramp = number(env, 'SIM_RAMP_SECONDS', 15, 1, 7200);
  const preAllocatedVUs = number(env, 'SIM_PRE_VUS', 2, 1, 1000);
  const maxVUs = number(env, 'SIM_VUS', 5, preAllocatedVUs, 2000);
  const p95 = number(env, 'SIM_P95_MS', 500, 1, 120_000);
  const errorRate = number(env, 'SIM_ERROR_PERCENT', 1, 0, 100) / 100;
  const stopDelay = number(env, 'SIM_STOP_DELAY_SECONDS', 10, 0, 7200);
  const patientReadPercent = number(env, 'SIM_PATIENT_READ_PERCENT', 0, 0, 100);
  const citasPercent = number(env, 'SIM_CITAS_PERCENT', 50, 0, 100);
  const maxDropped = number(env, 'SIM_MAX_DROPPED', 0, 0, 1_000_000);
  const studyPercent = number(env, 'SIM_STUDY_PERCENT', 50, 0, 100);
  const timeout = number(env, 'SIM_TIMEOUT_MS', 8000, 1, 120_000);
  const seed = number(env, 'SIM_SEED', 42, 0, 0xffffffff);
  const low = Math.max(1, Math.floor(rate / 4));
  const duration = seconds + 's';
  const rampDuration = ramp + 's';
  const stages = {
    progressive: [{ target: low, duration: rampDuration }, { target: rate, duration: rampDuration },
      { target: rate, duration }, { target: 0, duration: rampDuration }],
    peak: [{ target: rate, duration: rampDuration }, { target: rate, duration }, { target: low, duration: rampDuration }],
    spike: [{ target: rate, duration: '1s' }, { target: rate, duration }, { target: low, duration: '1s' }],
    saturation: [{ target: low, duration }, { target: rate, duration: rampDuration },
      { target: rate, duration }, { target: 0, duration: rampDuration }],
  };
  let executor;
  if (oneShot.has(name) || name === 'smoke') {
    executor = { executor: 'shared-iterations' as const, vus: 1, iterations: 1, maxDuration: '90s' };
  } else if (name === 'independent') {
    executor = { executor: 'per-vu-iterations' as const, vus: preAllocatedVUs, iterations: 1, maxDuration: '90s' };
  } else if (name in stages) {
    executor = { executor: 'ramping-arrival-rate' as const, startRate: low, timeUnit: '1s', preAllocatedVUs, maxVUs,
      stages: stages[name as keyof typeof stages] };
  } else {
    executor = { executor: 'constant-arrival-rate' as const, rate, timeUnit: '1s', duration, preAllocatedVUs, maxVUs };
  }
  return { name, seed, timeout, studyPercent, patientReadPercent, citasPercent,
    frustrationMode: mode(env), frustrationInitial: number(env, 'SIM_FRUSTRATION_INITIAL', 20, 0, 100),
    frustrationRetries: number(env, 'SIM_FRUSTRATION_RETRIES', 2, 0, 5),
    frictionDelayMs: number(env, 'SIM_FRICTION_DELAY_MS', 500, 1, 120_000), writes: writes.has(name), executor,
    thresholds: { http_req_duration: [{ threshold: 'p(95)<=' + p95, abortOnFail: true, delayAbortEval: stopDelay + 's' }],
      simulation_unexpected: [{ threshold: errorRate === 0 ? 'rate==0' : 'rate<' + errorRate, abortOnFail: true, delayAbortEval: stopDelay + 's' }],
      ...((executor.executor === 'constant-arrival-rate' || executor.executor === 'ramping-arrival-rate') && {
        dropped_iterations: [{ threshold: 'count<=' + maxDropped, abortOnFail: true, delayAbortEval: stopDelay + 's' }],
      }) } };
}
export function localOrigin(raw: string) {
  // No URL global dependency in the k6 runtime.
  const match = /^(https?):\/\/(127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?(?:\/api\/v1)?\/?$/.exec(raw);
  if (!match || (match[3] !== undefined && (+match[3] < 1 || +match[3] > 65535))) throw new Error('Destino HTTP no autorizado');
  return match[1] + '://' + match[2] + (match[3] ? ':' + match[3] : '');
}
export function loadPermission(env: Env, plan: ReturnType<typeof readLoadPlan>) {
  if (env.SIM_ENV !== 'local' || env.SIM_K6_CONFIRM !== 'isolated-loopback' ||
      (plan.writes && env.SIM_ALLOW_WRITES !== 'true')) throw new Error('k6 requiere autorización local explícita');
  return { central: localOrigin(env.SIM_CENTRAL_URL ?? 'http://127.0.0.1:3000'),
    orchestrator: localOrigin(env.SIM_ORCHESTRATOR_URL ?? 'http://127.0.0.1:3300') };
}

/** Budget from the observed ~112 ms worst iteration, with two warm VUs of margin. */
export function warmReadVUs(rate: number, maxVUs: number) {
  return Math.min(maxVUs, Math.max(4, Math.ceil(rate * 0.12) + 2));
}