import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { copyTarget } from '../data/copy.js';

const definitions = [
  { prefix: 'SIM_WEB', code: 'hackatec-fixture-web', scopes: ['JOURNEYS_READ', 'EVENTS_PUBLISH'] },
  { prefix: 'SIM_WHATSAPP', code: 'hackatec-fixture-whatsapp', scopes: ['JOURNEYS_READ', 'EVENTS_PUBLISH'] },
  { prefix: 'SIM_CALL_CENTER', code: 'hackatec-fixture-call-center', scopes: ['JOURNEYS_READ'] },
];
async function main() {
  if (process.env.SIM_CHANNEL_PROVISION !== 'local-fixtures') throw new Error('Autorización de canales requerida');
  const folder = process.argv[2];
  if (!folder || !/^reports\/local-lab-ff989cc(?:-[2-9])?$/.test(folder)) throw new Error('Carpeta de laboratorio inválida');
  const url = copyTarget(process.env.SIM_ORCHESTRATOR_DATABASE_URL, 'orchestrator', process.env);
  if (new URL(url).port !== '55432') throw new Error('Puerto de laboratorio inválido');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    const marker = await client.query<{ marker: string }>(
      "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    if (marker.rows[0]?.marker !== 'salud-digna:synthetic-only') throw new Error('Marca sintética ausente');
    for (const definition of definitions) {
      // The official credential CLI requires a pre-registered channel. No HTTP registration contract exists.
      await client.query('INSERT INTO public."Channel" (code,name) VALUES ($1,$2)', [definition.code, definition.code]);
    }
    await client.query('COMMIT');
  } finally { await client.end(); }
  const lines = ['SIM_CONTINUITY=true'];
  const runner = promisify(execFile);
  for (const channel of definitions) {
    const { stdout } = await runner(process.execPath, ['dist/channel-auth/create-channel-credential.js',
      '--channel', channel.code, ...channel.scopes.flatMap(scope => ['--scope', scope])], {
      cwd: resolve(folder, 'runtime/apps/orchestrator'), env: { ...process.env, DATABASE_URL: url,
        ORCHESTRATOR_DB_PORT: '55432', ORCHESTRATOR_DB_HOST: '127.0.0.1' },
    });
    const credential = stdout.trim();
    if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i.test(credential)) throw new Error('CLI de credencial incompatible');
    lines.push(channel.prefix + '_CODE=' + channel.code, channel.prefix + '_KEY=' + credential);
  }
  await writeFile(resolve(folder, 'channels.env'), lines.join('\n') + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ channels: definitions.length, officialCli: true }));
}
main().catch(() => { console.error('Aprovisionamiento local rechazado o interrumpido'); process.exitCode = 1; });
