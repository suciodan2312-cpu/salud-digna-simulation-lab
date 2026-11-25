import { open, readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CentralApi } from '../adapters/central-api/index.js';
import { HttpTransport } from '../adapters/transport/index.js';
import { readConfig } from '../config/index.js';
import { HttpError } from '../contracts/index.js';
import { schedule } from '../scenarios/index.js';
import { localTarget } from './targets.js';
import { verifyBindings } from './control.js';
import { databases, localPids, centralOrigin, orchestratorOrigin } from './monitor.js';

type Login = { email: string; password: string };
type Entry = Login & { upcomingUntil?: string; state: 'reserved' | 'ready' | 'deferred' };
const file = localTarget.folder + '/cohort-actors.jsonl';
export async function verifiedLab() {
  const config = readConfig();
  if (![55432, 55435].includes(localTarget.database) || config.environment !== 'local' ||
      config.central !== centralOrigin || config.orchestrator !== orchestratorOrigin) throw new Error('Destino no autorizado');
  await verifyBindings(await localPids());
  await databases();
  return config;
}
export async function privateRows<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
function check(login: Login) {
  if (!/^[^@\s]+@example\.test$/.test(login.email) || !login.password) throw new Error('Cuenta ficticia requerida');
  return login;
}
export async function patientPool() {
  const entries = new Map<string, Entry>();
  for (const row of await privateRows<Entry>(file)) {
    check(row);
    if (!['reserved','ready','deferred'].includes(row.state)) throw new Error('Journal de pacientes incompatible');
    entries.set(row.email, row);
  }
  return entries;
}
export async function preparePatients(target: number) {
  const cap = localTarget.database === 55432 ? 10 : 50;
  if (!Number.isInteger(target) || target < 1 || target > cap || process.env.SIM_ACTOR_APPROVAL !== 'synthetic-patients') {
    throw new Error('Cantidad o autorización inválida');
  }
  const cfg = await verifiedLab();
  const api = new CentralApi(new HttpTransport(cfg.central, { ...cfg, allowWrites: true, retries: 0 }), false);
  const primary = check({ email: process.env.SIM_PATIENT_EMAIL ?? '', password: process.env.SIM_PATIENT_PASSWORD ?? '' });
  const lockPath = 'reports/phase5-execution.lock';
  const lock = await open(lockPath, 'wx');
  try {
    const entries = await patientPool();
    const journal = await open(file, 'a', 0o600);
    try {
      const save = async (login: Login, state: Entry['state'], upcomingUntil?: string) => {
        const row = { email: login.email, password: login.password, state, upcomingUntil };
        await journal.appendFile(JSON.stringify(row) + '\n'); await journal.sync();
        entries.set(login.email, row);
      };
      let added = 0;
      for (let i = 0; i < target; i++) {
        const email = i === 0 ? primary.email : 'cohort-' + i + '@example.test';
        const entry = entries.get(email);
        if (entry?.state === 'ready' && Date.parse(entry.upcomingUntil ?? '') > Date.now() + 120_000) continue;
        if (added >= 3) break;
        const login = entry ?? (i === 0 ? primary : { email, password: randomBytes(32).toString('base64url') });
        if (i && (!entry || entry.state === 'deferred')) {
          await save(login, 'reserved');
          try { await api.register({ email, password: login.password, firstName: 'Paciente', lastName: 'Simulado ' + i }); }
          catch (e) {
            if (e instanceof HttpError && e.status === 429) await save(login, 'deferred');
            throw e;
          }
        }
        const session = await api.login(email, login.password, 'PATIENT');
        let appt = (await api.appointments(session, { limit: 1 }, true)).items[0];
        if (!appt) {
          await schedule(api, session);
          appt = (await api.appointments(session, { limit: 1 }, true)).items[0];
        }
        if (!appt || !(await api.history(session, appt.requestId)).some(e => e.type === 'APPOINTMENT_CONFIRMED')) {
          throw new Error('Cita o historial sin verificar');
        }
        if (!(await api.requests(session, { limit: 1 }, true)).items.length) await api.create(session);
        if (!(await api.requests(session, { limit: 1 }, true)).items.length) throw new Error('Solicitud pendiente ausente');
        await save(login, 'ready', appt.scheduledAt);
        added++;
        if (i + 1 < target && added < 3) await delay(1000);
      }
      return { verifiedThisBatch: added, ready: [...entries.values()].filter(e => e.state === 'ready').length, target };
    } finally { await journal.close(); }
  } finally { await lock.close(); await unlink(lockPath); }
}
