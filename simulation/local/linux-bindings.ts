import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { integrationRevision, localTarget, targets } from './targets.js';

export async function linuxBindings() {
  if (localTarget !== targets['integration-5m'] ||
      (await readFile('/opt/sd-lab/services/REVISION','utf8')).trim() !== integrationRevision) {
    throw new Error('Revisión o laboratorio Linux no autorizado');
  }
  const raw = await new Promise<string>((resolve,reject) => {
    const socket = createConnection('/run/sd-lab-bindings.sock');
    let data = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Verificación local agotada')));
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 256) socket.destroy(new Error('Respuesta local inválida'));
    });
    socket.on('error', reject);
    socket.on('end', () => resolve(data));
  });
  const ids = JSON.parse(raw);
  for (const key of ['central','orchestrator','postgres']) {
    if (!Number.isSafeInteger(ids?.[key]) || ids[key] <= 0) throw new Error('Listener no verificado');
  }
  return { central: Number(ids.central), orchestrator: Number(ids.orchestrator), postgres: Number(ids.postgres) };
}
