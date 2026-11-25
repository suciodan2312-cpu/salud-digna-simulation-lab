import { preparePatients } from './cohort-pool.js';
import { HttpError } from '../contracts/index.js';
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { CentralApi } from '../adapters/central-api/index.js';
import { HttpTransport } from '../adapters/transport/index.js';
import { readConfig } from '../config/index.js';
import { schedule } from '../scenarios/index.js';
import { verifyBindings } from './control.js';
import { centralOrigin, localPids, databases } from './monitor.js';
import { localTarget } from './targets.js';

async function main() {
  if (process.argv[2] === 'cohort') { console.log(JSON.stringify(await preparePatients(Number(process.argv[3] ?? 3)))); return; }
  const config = readConfig();
  const count = Number(process.argv[2] ?? '3');
  if (process.env.SIM_ACTOR_APPROVAL !== 'synthetic-patients' || localTarget.database !== 55433 ||
      config.environment !== 'local' || config.central !== centralOrigin || !Number.isInteger(count) || count < 1 || count > 4) {
    throw new Error('Aprovisionamiento fuera de alcance');
  }
  await verifyBindings(await localPids());
  await databases();
  const api = new CentralApi(new HttpTransport(config.central, { ...config, allowWrites: true, retries: 0 }), false);
  const actors = await open(localTarget.folder + '/actors-pool.jsonl', 'wx');
  let registered = 0;
  try {
    for (let index = 0; index < count; index++) {
      const email = 'patient-capacity-' + (index + 1) + '@example.test';
      const password = randomBytes(32).toString('base64url');
      await api.register({ firstName: 'Paciente', lastName: 'Capacidad ' + (index + 1), email, password });
      await actors.appendFile(JSON.stringify({ email, password }) + '\n');
      const patient = await api.login(email, password, 'PATIENT');
      if (!(await schedule(api, patient)).confirmed) throw new Error('Cita de prueba no confirmada');
      await api.create(patient);
      registered++;
    }
  } finally { await actors.close(); }
  console.log(JSON.stringify({ registered, appointmentsConfirmed: registered, openRequestsCreated: registered }));
}
main().catch((error: unknown) => { if (error instanceof HttpError) console.error('HTTP', error.status, 'Retry-After ms', error.retryAfterMs ?? 'sin dato');  console.error('Aprovisionamiento detenido; las cuentas creadas quedan en el archivo privado'); process.exitCode = 1; });
