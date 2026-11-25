import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { runProfile } from '../engine/behavior.js';
import { CentralApi } from '../adapters/central-api/index.js';
import { HttpTransport } from '../adapters/transport/index.js';
import { readConfig } from '../config/index.js';
import { HttpError, type Role } from '../contracts/index.js';
import { schedule, admin } from '../scenarios/index.js';
import { verifyBindings, runId } from './control.js';
import { centralOrigin, databases, localPids } from './monitor.js';

async function main() {
  const config = readConfig();
  if (config.environment !== 'local' || config.central !== centralOrigin || !config.allowWrites ||
      process.env.SIM_STAFF_APPROVAL !== 'local-fixtures') throw new Error('Autorización local requerida');
  const id = runId(process.argv[2]);
  await verifyBindings(await localPids());
  await databases();
  const transport = new HttpTransport(config.central, { ...config, retries: 0 });
  const api = new CentralApi(transport, config.capabilities.conversation);
  const login = async (role: Role) => {
    const email = process.env['SIM_' + role + '_EMAIL'];
    const password = process.env['SIM_' + role + '_PASSWORD'];
    if (!email?.endsWith('@example.test') || !password) throw new Error('Cuenta ficticia requerida');
    const session = await api.login(email, password, role);
    const actor = await api.me(session);
    if (actor.role !== role) throw new Error('Rol incompatible');
    return session;
  };
  const patient = await login('PATIENT'), advisor = await login('ADVISOR'), administrator = await login('ADMIN');
  async function rejected(path: string, operation: string, status: number, token?: string) {
    try {
      await transport.send({ path, operation, headers: token ? { authorization: 'Bearer ' + token } : undefined }, () => null);
    } catch (error) {
      if (error instanceof HttpError && error.status === status) return { operation, status };
      throw error;
    }
    throw new Error('Permiso inesperado');
  }
  const permissions = [
    await rejected('/api/v1/admin/overview', 'sin-sesion', 401),
    await rejected('/api/v1/admin/overview', 'paciente-admin', 403, patient.token),
    await rejected('/api/v1/admin/overview', 'asesor-admin', 403, advisor.token),
    await rejected('/api/v1/appointments', 'admin-citas-propias', 403, administrator.token),
  ];
  const assisted = await schedule(api, patient, advisor);
  const overview = await admin(api, administrator);
  if (process.env.SIM_STAFF_FRUSTRATION === 'true') {
    const recovery = await runProfile('frustrado', { api, patient, advisor, behavior: {
      mode: 'initial', initial: 95, seed: 42, retryBudget: 1, delayMs: 500,
      canConverse: false, allowAssistanceRequest: true, timing: { now: () => performance.now(), wait: ms => delay(ms) },
    } });
    await writeFile('reports/phase5-frustration-' + id + '.json', JSON.stringify(recovery, null, 2), { flag: 'wx' });
  }
  const result = { kind: 'functional-real', roles: ['PATIENT', 'ADVISOR', 'ADMIN'], permissions, assisted,
    admin: { listed: overview.listed, historyEntries: overview.historyEntries }, finishedAt: new Date().toISOString() };
  await writeFile('reports/phase4-staff-' + id + '.json', JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(() => { console.error('La validación de roles no concluyó. Revisa el estado del laboratorio y las cuentas ficticias.');
  process.exitCode = 1; });
