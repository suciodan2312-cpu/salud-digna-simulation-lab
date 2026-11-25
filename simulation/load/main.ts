import { sleep } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { CentralApi, type CentralSession } from '../adapters/central-api/index.js';
import { Orchestrator, type ChannelCredential } from '../adapters/orchestrator/index.js';
import type { Transport, Request } from '../adapters/transport/index.js';
import { CapabilityError, ContractError, HttpError, NetworkError, requireFresh, type Decoder } from '../contracts/index.js';
import { frustrated } from '../engine/behavior.js';
import { formatReports, reportMetadata } from '../reports/format.js';
import { basic, continuity, idempotency, schedule, versionConflict } from '../scenarios/index.js';
import { loadPermission, readLoadPlan } from './plan.js';

const plan = readLoadPlan(__ENV);
const metadata = reportMetadata(plan.name, plan.seed, __ENV);
const reportName = __ENV.SIM_RUN_ID ?? plan.name;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(reportName)) throw new Error('Identificador de reporte inválido');
// Authorization is checked before any VU can issue HTTP.
const origins = loadPermission(__ENV, plan);
const unexpected = new Rate('simulation_unexpected');
const operations = new Counter('simulation_operations');
const expected409 = new Counter('simulation_expected_409');
const expected429 = new Counter('simulation_expected_429');
const contexts = new Counter('simulation_contexts');
const handoffs = new Counter('simulation_handoffs');
const duplicates = new Counter('simulation_duplicates');
const appointments = new Counter('simulation_appointments');
const abandoned = new Counter('simulation_abandoned');
const resumed = new Counter('simulation_resumed');
const assistance = new Counter('simulation_assistance');
const initial = new Trend('simulation_frustration_initial');
const final = new Trend('simulation_frustration_final');
const resolution = new Trend('simulation_resolution_ms', true);
export const options = {
  scenarios: { selected: plan.executor },
  thresholds: {
    ...plan.thresholds,
    ...(__ENV.SIM_CODE_REVISION?.endsWith('+simulation-phase7') && {
      'http_reqs{name:central.pending}': [], 'http_reqs{name:central.appointments}': [],
      'http_req_duration{name:central.pending}': [], 'http_req_duration{name:central.appointments}': [],
    }),
  },
  maxRedirects: 0,
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  summaryTrendStats: ['avg', 'min', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

class K6Transport implements Transport {
  constructor(private readonly origin: string) {}
  async send<T>(request: Request, decode: Decoder<T>) {
    const method = request.method ?? 'GET';
    if ((method !== 'GET' || request.writes) && !plan.writes) throw new CapabilityError('escritura k6');
    if (!/^\/api\/v1\/[a-z]/.test(request.path) || request.path.split('?')[0]!.includes('..')) {
      throw new CapabilityError('ruta k6');
    }
    const headers = { Accept: 'application/json', ...request.headers,
      ...(request.body !== undefined && { 'Content-Type': 'application/json' }) };
    const response = http.request(method, this.origin + request.path,
      request.body === undefined ? null : JSON.stringify(request.body),
      { headers, tags: { name: request.operation }, redirects: 0, timeout: plan.timeout + 'ms' });
    const wanted = request.expected ?? 200;
    if (response.status === 0) throw new NetworkError();
    if (response.status !== wanted) {
      if (response.status >= 200 && response.status < 300) throw new ContractError('estado HTTP');
      const raw = response.headers['Retry-After'];
      const delay = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : undefined;
      throw new HttpError(response.status, delay);
    }
    let body: unknown;
    try { body = response.json(); } catch { throw new ContractError('JSON'); }
    return decode(body);
  }
}

function required(key: string) {
  const value = __ENV[key];
  if (!value) throw new CapabilityError(key);
  return value;
}
function session(role: CentralSession['role']): CentralSession {
  const token = required('SIM_' + role + '_TOKEN');
  const expiresAt = required('SIM_' + role + '_EXPIRES_AT');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new CapabilityError('caducidad de JWT');
  requireFresh(expiresAt, 'JWT vigente');
  return { token, role, expiresAt };
}
const pool = __ENV.SIM_PATIENT_SESSIONS ? JSON.parse(__ENV.SIM_PATIENT_SESSIONS) as CentralSession[] : [];
function patientFor(iteration: number) {
  const selected = pool[iteration % pool.length];
  if (!selected) return session('PATIENT');
  requireFresh(selected.expiresAt, 'JWT vigente');
  return selected;
}
function channel(name: ChannelCredential['channel'], prefix: string): ChannelCredential {
  return { channel: name, key: required(prefix + '_KEY'), expectedCode: required(prefix + '_CODE') };
}
const central = new CentralApi(new K6Transport(origins.central), __ENV.SIM_CONVERSATION === 'true');
const availableChannels = (__ENV.SIM_CHANNELS ?? 'web,whatsapp,call-center').split(',');
if (availableChannels.some(value => !['web', 'whatsapp', 'call-center'].includes(value)) ||
    new Set(availableChannels).size !== availableChannels.length) throw new CapabilityError('canales k6');
const orchestrator = new Orchestrator(new K6Transport(origins.orchestrator),
  availableChannels as ChannelCredential['channel'][], __ENV.SIM_CONTINUITY === 'true');
const ids = {
  key: () => encoding.b64encode(crypto.randomBytes(32), 'rawurl'),
  uuid: () => {
    const bytes = new Uint8Array(crypto.randomBytes(16));
    bytes[6] = (bytes[6]! & 15) | 64;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  },
};
async function operation() {
  switch (plan.name) {
    case 'smoke':
      await basic(central, orchestrator);
      if (__ENV.SIM_SMOKE_PATIENT === 'true') {
        const patient = session('PATIENT');
        await central.me(patient);
        await central.requests(patient, { limit: 1 }, true);
      }
      return;
    case 'admin': await central.adminOverview(session('ADMIN')); return;
    case 'independent':
      if (!availableChannels.includes('web')) throw new CapabilityError('canal Web');
      if ((await schedule(central, session('PATIENT'))).confirmed) appointments.add(1);
      return;
    case 'version-conflict': {
      const result = await versionConflict(central, session('PATIENT'));
      if (result.conflict) expected409.add(1);
      if (result.resolved) contexts.add(1);
      return;
    }
    case 'idempotency': {
      const result = await idempotency(orchestrator, channel('web', 'SIM_WEB'), ids);
      if (result.sameJourney) duplicates.add(1);
      if (result.sameEvent) duplicates.add(1);
      return;
    }
    case 'continuity': {
      if (__ENV.SIM_CONTINUITY !== 'true' || availableChannels.length !== 3) throw new CapabilityError('continuidad k6');
      const result = await continuity(central, orchestrator, { web: channel('web', 'SIM_WEB'),
        whatsapp: channel('whatsapp', 'SIM_WHATSAPP'), callCenter: channel('call-center', 'SIM_CALL_CENTER') }, ids);
      handoffs.add(result.handoffs);
      contexts.add(result.handoffs);
      return;
    }
    case 'frustrated': {
      const state = await frustrated(central, session('PATIENT'), {
        mode: plan.frustrationMode, allowAssistanceRequest: availableChannels.includes('call-center'), seed: plan.seed, initial: plan.frustrationInitial, retryBudget: plan.frustrationRetries, delayMs: plan.frictionDelayMs,
        canConverse: availableChannels.includes('whatsapp') && __ENV.SIM_CONVERSATION === 'true',
        timing: { now: Date.now, wait: async ms => { sleep(ms / 1000); } },
      }, availableChannels.includes('call-center') && __ENV.SIM_ADVISOR_TOKEN ? session('ADVISOR') : undefined);
      initial.add(state.initial);
      final.add(state.final);
      if (state.conflicts) expected409.add(state.conflicts);
      if (state.throttled) expected429.add(state.throttled);
      if (state.abandoned) abandoned.add(1);
      if (state.resumed) resumed.add(1);
      if (state.assistance) assistance.add(1);
      if (state.channel !== 'web') handoffs.add(1);
      if (state.resolvedMs === undefined) return state.requestErrors || state.denied ? 'unexpected' : false;
      contexts.add(1);
      resolution.add(state.resolvedMs);
      return state.requestErrors ? 'recovered' : undefined;
    }
    default: {
      // Deterministic mix. Authenticated routes use a session provisioned outside k6.
      if (plan.patientReadPercent > 0 && !availableChannels.includes('web')) throw new CapabilityError('canal Web');
      const index = exec.scenario.iterationInTest + plan.seed;
      const patientBucket = (Math.imul(index + 101, 1597334677) >>> 0) % 100;
      if (patientBucket < plan.patientReadPercent) {
        const patient = patientFor(exec.scenario.iterationInTest);
        const citasBucket = (Math.imul(index + 157, 2246822519) >>> 0) % 100;
        if (citasBucket < plan.citasPercent) await central.appointments(patient, { limit: 10 }, true);
        else await central.requests(patient, { limit: 10 }, true);
        return;
      }
      const value = (Math.imul(exec.scenario.iterationInTest + plan.seed, 2654435761) >>> 0) % 100;
      await central.catalog(value < plan.studyPercent ? 'studies' : 'clinics', { limit: 10 });
    }
  }
}

export default async function () {
  try {
    const result = await operation();
    if (result !== false && result !== 'unexpected') operations.add(1);
    unexpected.add(result === 'unexpected' || result === 'recovered');
  } catch (error) {
    if (error instanceof HttpError && error.status === 429 && ['continuity', 'frustrated'].includes(plan.name)) {
      expected429.add(1);
      unexpected.add(false);
    } else {
      unexpected.add(true);
    }
  }
}

export function handleSummary(data: { state?: { testRunDurationMs?: number }; metrics: Record<string, { values?: Record<string, unknown> }> }) {
  const { json, csv } = formatReports({ ...metadata, finishedAt: new Date().toISOString(),
    durationMs: data.state?.testRunDurationMs ?? null,
    authenticatedIdentities: Number(__ENV.SIM_IDENTITY_COUNT) || undefined,
    configuration: { executor: plan.executor.executor, timeoutMs: plan.timeout,
      preAllocatedVUs: plan.executor.preAllocatedVUs ?? plan.executor.vus ?? 1,
      maxVUs: plan.executor.maxVUs ?? plan.executor.vus ?? 1,
      rate: plan.executor.rate ?? plan.executor.startRate ?? null },
  }, data.metrics);
  return { ['reports/k6-' + reportName + '.json']: json, ['reports/k6-' + reportName + '.csv']: csv,
    stdout: 'Resumen exportado: ' + plan.name + '\n' };
}
