import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import pg from 'pg';
import { copyTarget } from '../data/copy.js';
import { services, type Service } from '../data/corpus.js';

import { linuxBindings } from './linux-bindings.js';
import { localTarget, serviceRevision } from './targets.js';
const lab = localTarget.folder;
export const centralOrigin = 'http://127.0.0.1:' + localTarget.central;
export const orchestratorOrigin = 'http://127.0.0.1:' + localTarget.orchestrator;
const run = promisify(execFile);
const processId = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('PID local inválido');
  return value;
};

export async function localPids() {
  if (process.platform === 'linux') return linuxBindings();
  const raw = JSON.parse(await readFile(lab + '/processes.json', 'utf8')) as Record<string, unknown>;
  const info = (await readFile(lab + '/pgdata/postmaster.pid', 'utf8')).split(/\r?\n/);
  if (raw.base !== serviceRevision || info[3] !== String(localTarget.database) ||
      info[5] !== '127.0.0.1' || info[7]?.trim() !== 'ready') throw new Error('Identidad del laboratorio incompatible');
  return { central: processId(raw.centralPid), orchestrator: processId(raw.orchestratorPid),
    postgres: processId(Number(info[0])) };
}

export function readLabUrl(service: Service, env = process.env) {
  const key = service === 'central' ? 'SIM_CENTRAL_DATABASE_URL' : 'SIM_ORCHESTRATOR_DATABASE_URL';
  const url = copyTarget(env[key], service, { ...env, SIM_COPY_CONFIRM: 'salud-digna:synthetic-only' });
  const resolved = new URL(url);
  if (resolved.hostname !== '127.0.0.1' || resolved.port !== String(localTarget.database)) throw new Error('Base fuera del laboratorio autorizado');
  return url;
}
const tables = {
  central: ['ServiceRequest', 'Appointment', 'DomainEvent', 'AuditLog'],
  orchestrator: ['Journey', 'JourneyEvent', 'JourneyContext', 'AccessAudit'],
};
export async function databases(env = process.env, integrity = false) {
  const results = await Promise.all(services.map(async service => {
    const client = new pg.Client({ connectionString: readLabUrl(service, env), application_name: 'simulation_monitor',
      connectionTimeoutMillis: 3000, statement_timeout: 3000 });
    try {
      await client.connect();
      const result = await client.query(`
        SELECT shobj_description(d.oid,'pg_database') AS marker,
          pg_database_size(d.oid)::text AS "databaseBytes", s.numbackends AS connections,
          s.xact_commit::text AS commits, s.xact_rollback::text AS rollbacks,
          s.tup_returned::text AS "tuplesReturned", s.tup_fetched::text AS "tuplesFetched",
          s.deadlocks::text AS deadlocks,
          (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname=d.datname AND a.state='active' AND a.pid<>pg_backend_pid()) AS active,
          (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname=d.datname AND a.wait_event_type='Lock') AS waiting,
          (SELECT count(*)::int FROM pg_locks l WHERE l.database=d.oid AND NOT l.granted) AS "blockedLocks",
          (SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='pg_stat_statements')) AS "statementsAvailable",
          (SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements')) AS "statementsInstalled",
          (SELECT 'pg_stat_statements'=ANY(string_to_array(replace(setting,' ',''), ','))
            FROM pg_settings WHERE name='shared_preload_libraries') AS "statementsPreloaded"
        FROM pg_database d JOIN pg_stat_database s ON s.datid=d.oid WHERE d.datname=current_database()
      `);
      const row = result.rows[0];
      if (row?.marker !== 'salud-digna:synthetic-only') throw new Error('Base sin marca sintética');
      const counts: Record<string, string> = {};
      if (integrity) for (const table of tables[service]) {
        const count = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM public."' + table + '"');
        counts[table] = count.rows[0]!.count;
      }
      const { marker: _marker, ...metrics } = row;
      return [service, { ...metrics, counts: integrity ? counts : null }] as const;
    } finally { await client.end().catch(() => {}); }
  }));
  return Object.fromEntries(results);
}
type Group = { cpuSeconds: number; residentBytes: number; processes: number };
export async function resources(pids: Awaited<ReturnType<typeof localPids>>, k6?: number) {
  const drive = await statfs('.');
  const ids = [pids.central, pids.orchestrator, pids.postgres, k6 ?? 0];
  if (k6 !== undefined) processId(k6);
  const command = `
$roots=@(${ids.join(',')})
$children=@{}
Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" -ErrorAction Stop | ForEach-Object {
  $key=[int]$_.ParentProcessId
  $children[$key]=@($children[$key]) + [int]$_.ProcessId
}
$out=@()
for($i=0;$i -lt $roots.Count;$i++){
  $root=$roots[$i]
  if($root -le 0){ $out+=,$null; continue }
  $all=@($root)
  if($i -eq 2){
    for($p=0;$p -lt $all.Length;$p++){
      foreach($child in $children[$all[$p]]){ if($child -and $child -notin $all){ $all+= $child } }
    }
  }
  $group=@(Get-Process -Id $all -ErrorAction SilentlyContinue)
  if(!$group.Count){ $out+=,$null; continue }
  $out+=,[pscustomobject]@{cpuSeconds=($group | Measure-Object CPU -Sum).Sum;residentBytes=($group | Measure-Object WorkingSet64 -Sum).Sum;processes=$group.Count}
}
ConvertTo-Json -InputObject $out -Compress
`;
  let groups: (Group | null)[] = [];
  try {
    const shell = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 4000, windowsHide: true });
    groups = JSON.parse(stdout) as (Group | null)[];
  } catch { /* Unavailable readings remain null. */ }
  return { observedAt: new Date().toISOString(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
    diskFreeBytes: drive.bavail * drive.bsize, central: groups[0] ?? null, orchestrator: groups[1] ?? null,
    postgres: groups[2] ?? null, k6: groups[3] ?? null };
}
