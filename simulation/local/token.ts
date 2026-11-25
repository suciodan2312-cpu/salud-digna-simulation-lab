import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CentralApi } from '../adapters/central-api/index.js';
import { HttpTransport } from '../adapters/transport/index.js';
import { readConfig } from '../config/index.js';

async function main() {
  const folder = process.argv[2];
  const config = readConfig();
  const email = process.env.SIM_PATIENT_EMAIL;
  const password = process.env.SIM_PATIENT_PASSWORD;
  if (!folder || !/^reports\/local-lab-ff989cc(?:-[2-9])?$/.test(folder) ||
      config.environment !== 'local' || config.central !== 'http://127.0.0.1:13100' || !email?.endsWith('@example.test') || !password) {
    throw new Error('Paciente ficticio y laboratorio requeridos');
  }
  const api = new CentralApi(new HttpTransport(config.central, config), false);
  const session = await api.login(email, password, 'PATIENT');
  const account = await api.me(session);
  if (account.role !== 'PATIENT' || !account.patientId) throw new Error('Rol incompatible');
  await writeFile(resolve(folder, 'smoke-token.env'),
    'SIM_PATIENT_TOKEN=' + session.token + '\nSIM_PATIENT_EXPIRES_AT=' + session.expiresAt + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ role: account.role, verified: true }));
}
main().catch(() => { console.error('No se pudo aprovisionar la sesión local de smoke'); process.exitCode = 1; });
