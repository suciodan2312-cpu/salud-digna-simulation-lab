import { access, open, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CentralApi } from '../adapters/central-api/index.js';
import { Orchestrator, type ChannelCredential } from '../adapters/orchestrator/index.js';
import { HttpTransport, type Request, type Transport } from '../adapters/transport/index.js';
import { readConfig, type Config } from '../config/index.js';
import { chooseProfile, seededRandom } from '../engine/index.js';
import { runProfile } from '../engine/behavior.js';
import { profiles, type Profile } from '../profiles/index.js';
import { verifyBindings, runId } from './control.js';
import { centralOrigin, databases, localPids, orchestratorOrigin } from './monitor.js';
import type { Decoder } from '../contracts/index.js';
import { patientFixtures } from '../data/index.js';

const patientProfiles: Profile[] = ['nuevo', 'frecuente', 'omnicanal', 'frustrado', 'indeciso', 'dificultades', 'citas'];
function input() {
  const raw = JSON.parse(process.env.SIM_BEHAVIOR_CONFIG ?? '{}') as Record<string, unknown>;
  const { seed, waitMs, initial, seconds, mix } = raw;
  function bounded(n: unknown, max: number): n is number { return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max; }
  if (!bounded(seed, 0xffffffff) || !bounded(waitMs, 5000) || !bounded(initial, 100) ||
      (seconds !== 30 && seconds !== 60) || !mix || typeof mix !== 'object') throw new Error('Configuración de comportamiento inválida');
  const entries = Object.entries(mix);
  if (entries.length !== patientProfiles.length || entries.some(([k, v]) => !patientProfiles.includes(k as Profile) || !bounded(v, 100)) ||
      entries.reduce((sum, [, v]) => sum + Number(v), 0) !== 100) throw new Error('La mezcla debe sumar 100');
  const weights = Object.fromEntries(Object.keys(profiles).map(key => [key, (mix as Record<string, number>)[key] ?? 0])) as Config['weights'];
  return { seed, waitMs, initial, seconds, weights };
}
function required(key: string) {
  const value = process.env[key];
  if (!value) throw new Error('Credencial ficticia ausente');
  return value;
}
function credential(channel: ChannelCredential['channel'], prefix: string): ChannelCredential {
  return { channel, key: required(prefix + '_KEY'), expectedCode: required(prefix + '_CODE') };
}
async function main() {
  const { seed, waitMs, initial, seconds, weights } = input();
  const config = readConfig();
  const id = runId(process.argv[2]);
  if (process.env.SIM_BEHAVIOR_APPROVAL !== 'one-local-profile' || config.environment !== 'local' ||
      config.central !== centralOrigin || centralOrigin !== 'http://127.0.0.1:13100' || config.orchestrator !== orchestratorOrigin) {
    throw new Error('Comportamiento autorizado solo en el laboratorio original');
  }
  await verifyBindings(await localPids());
  await databases();
  const lockPath = 'reports/phase5-execution.lock';
  const lock = await open(lockPath, 'wx');
  const root = 'reports/phase6-behavior-' + id;
  const start = Date.now();
  const chosen = chooseProfile(weights, seededRandom(seed));
  let state = 'failed';
  try {
    const gate = async () => {
      const stopped = await access('reports/phase6-' + id + '.stop').then(() => true, () => false);
      if (stopped || Date.now() - start > seconds * 1000) { state = stopped ? 'cancelled' : 'failed'; throw new Error('Detenido'); }
    };
    const wrap = (origin: string): Transport => {
      const http = new HttpTransport(origin, { ...config, allowWrites: true, retries: 0, timeoutMs: 3000 });
      return { async send<T>(request: Request, decode: Decoder<T>) { await gate(); return http.send(request, decode); } };
    };
    const api = new CentralApi(wrap(config.central), config.capabilities.conversation);
    const orch = new Orchestrator(wrap(config.orchestrator), config.enabledChannels, true);
    const existing = required('SIM_PATIENT_EMAIL');
    const password = required('SIM_PATIENT_PASSWORD');
    if (!existing.endsWith('@example.test')) throw new Error('Cuenta no ficticia');
    const patient = chosen === 'nuevo' || chosen === 'omnicanal' ? undefined : await api.login(existing, password, 'PATIENT');
    const registration = chosen === 'nuevo' ? { ...patientFixtures(seed, 1).next().value!,
      email: 'comportamiento-' + id + '@example.test', password } : undefined;
    const result = await runProfile(chosen, {
      api, patient, registration, orchestration: chosen === 'omnicanal' ? [api, orch, {
        web: credential('web', 'SIM_WEB'), whatsapp: credential('whatsapp', 'SIM_WHATSAPP'),
        callCenter: credential('call-center', 'SIM_CALL_CENTER'),
      }] : undefined,
      behavior: { seed, initial, mode: 'initial', retryBudget: 1, delayMs: 500, canConverse: config.capabilities.conversation,
        allowAssistanceRequest: true, timing: { now: Date.now, wait: async ms => { await gate(); await delay(Math.max(ms, waitMs)); await gate(); } } },
    });
    state = 'completed';
    await writeFile(root + '.json', JSON.stringify({ kind: 'functional-real', state, configured: weights, observed: { [chosen]: 1 },
      finishedAt: new Date().toISOString(), result }, null, 2), { flag: 'wx' });
  } finally {
    if (state !== 'completed') await writeFile(root + '.json', JSON.stringify({ kind: 'functional-real', state, configured: weights,
      observed: {}, finishedAt: new Date().toISOString() }), { flag: 'wx' }).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
main().catch(() => { console.error('El recorrido terminó antes de completarse.'); process.exitCode = 1; });
