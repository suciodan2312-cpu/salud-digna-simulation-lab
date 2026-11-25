import { serviceSource } from '../config/service-source.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { fileName, services, tableEntries, type Service } from './corpus.js';
import { validateDataset, type Manifest } from './dataset.js';

const databases = { central: 'salud_digna_simulation', orchestrator: 'salud_digna_orchestrator' };
const migrations = {
  central: ['20261121191248_init_omnichannel', '20261121201000_add_identity_link',
    '20261121203200_add_assistance_authorization', '20261122180000_add_whatsapp_inbox', '20261122190000_add_whatsapp_provider'],
  orchestrator: ['20261124061014_init_orchestrator', '20261124061840_add_channel_access',
    '20261124075314_add_journey_creation_idempotency', '20261124082308_add_continuity_codes'],
};
const fixtureMarker = 'salud-digna:synthetic-only';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const relation = (table: string) => 'public.' + quote(table);

export function planCopy(manifest: Manifest, batchRows: number) {
  if (!Number.isInteger(batchRows) || batchRows < 1 || batchRows > 10_000) throw new Error('SIM_COPY_BATCH inválido');
  return services.map(service => ({ service, order: tableEntries(service)
    .filter(([table]) => manifest.tables[service][table]!.rows > 0)
    .map(([table, columns]) => {
      const expected = manifest.tables[service][table]!;
      const sql = `COPY ${relation(table)} (${columns.split(' ').map(quote).join(', ')}) FROM STDIN WITH (FORMAT text)`;
      return { table, columns: columns.split(' '), sql, expected, batches: Math.ceil(expected.rows / batchRows) };
    }) }));
}

export function copyTarget(raw: string | undefined, service: Service, env: NodeJS.ProcessEnv) {
  if (env.SIM_ENV !== 'local' || env.SIM_COPY_CONFIRM !== fixtureMarker) throw new Error('COPY requiere autorización local explícita');
  const url = raw && URL.parse(raw);
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' + databases[service] || !url.username || !url.password || url.search || url.hash) {
    throw new Error(`Destino COPY no autorizado (${service})`);
  }
  return url.href;
}

async function expectedMigrations(service: Service) {
  const app = service === 'central' ? 'api' : 'orchestrator';
  const result = new Map<string, string[]>();
  for (const name of migrations[service]) {
    const content = await readFile(serviceSource('apps', app, 'prisma', 'migrations', name, 'migration.sql'), 'utf8');
    const lf = content.replaceAll('\r\n', '\n');
    result.set(name, [lf, lf.replaceAll('\n', '\r\n')].map(value => createHash('sha256').update(value).digest('hex')));
  }
  return result;
}

async function verifyDatabase(client: pg.Client, group: ReturnType<typeof planCopy>[number], empty = true, lock = true) {
  const target = await client.query<{ name: string; marker: string }>(
    "SELECT datname AS name, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
  if (target.rows[0]?.name !== databases[group.service] || target.rows[0]?.marker !== fixtureMarker) {
    throw new Error('La base requiere la marca de entorno sintético');
  }
  const expected = await expectedMigrations(group.service);
  const applied = await client.query<{ migration_name: string; checksum: string; finished: boolean }>(
    'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished FROM public._prisma_migrations WHERE rolled_back_at IS NULL');
  if (applied.rowCount !== expected.size || new Set(applied.rows.map(row => row.migration_name)).size !== expected.size ||
      applied.rows.some(row => !row.finished || !expected.get(row.migration_name)?.includes(row.checksum))) {
    throw new Error('Migraciones distintas de la revisión auditada');
  }
  const names = group.order.map(row => relation(row.table)).join(', ');
  if (lock) await client.query('LOCK TABLE ' + names + ' IN SHARE ROW EXCLUSIVE MODE');
  for (const entry of group.order) {
    const columns = await client.query<{ column_name: string; has_default: boolean; is_nullable: string }>(
      "SELECT column_name, column_default IS NOT NULL AS has_default, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
      [entry.table]);
    if (entry.columns.some(name => !columns.rows.some(row => row.column_name === name)) ||
        columns.rows.some(row => row.is_nullable === 'NO' && !row.has_default && !entry.columns.includes(row.column_name))) {
      throw new Error(`Columnas incompatibles (${entry.table})`);
    }
    if (!empty) continue;
    const rows = await client.query('SELECT 1 FROM ' + relation(entry.table) + ' LIMIT 1');
    if (rows.rowCount) throw new Error(`Tabla ocupada o carga previa (${entry.table})`);
  }
}

export async function loadCopy(directory: string, batchRows: number, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const manifest = await validateDataset(directory);
  const plan = planCopy(manifest, batchRows).filter(group => group.order.length);
  const targets = plan.map(({ service }) => copyTarget(
    env[service === 'central' ? 'SIM_CENTRAL_DATABASE_URL' : 'SIM_ORCHESTRATOR_DATABASE_URL'], service, env));
  const start = performance.now();
  const journal = await open(resolve(directory, 'copy-journal.jsonl'), 'wx');
  const clients: pg.Client[] = [];
  const record = async (data: object) => {
    await journal.appendFile(JSON.stringify({ dataset: manifest.id, ...data }) + '\n');
    await journal.sync();
  };
  try {
    // Preflight both destinations before starting COPY. Locks stay held until commit or rollback.
    for (const [index, group] of plan.entries()) {
      signal.throwIfAborted();
      const client = new pg.Client({ connectionString: targets[index]!, connectionTimeoutMillis: 5000,
        statement_timeout: 120_000, lock_timeout: 5000 });
      clients.push(client);
      client.on('error', () => {}); // Awaited operations and counts surface failure without exposing server messages.
      await client.connect();
      await client.query('BEGIN');
      await verifyDatabase(client, group);
      await record({ service: group.service, state: 'preflight' });
    }
    for (const [index, group] of plan.entries()) {
      const client = clients[index]!;
      for (const entry of group.order) {
        const hash = createHash('sha256');
        const input = createReadStream(resolve(directory, fileName(group.service, entry.table)), { signal });
        const lines = createInterface({ input, crlfDelay: Infinity });
        let batch: string[] = [], batches = 0, count = 0;
        const flush = async () => {
          signal.throwIfAborted();
          await pipeline(Readable.from(batch), client.query(copyFrom(entry.sql)), { signal });
          await record({ service: group.service, table: entry.table, batch: ++batches, rows: batch.length, state: 'provisional' });
          batch = [];
        };
        try {
          for await (const line of lines) {
            const row = line + '\n';
            count++;
            if (count > entry.expected.rows || row.length > 65_536) throw new Error('Archivo COPY inesperado');
            hash.update(row);
            batch.push(row);
            if (batch.length >= batchRows) await flush();
          }
          if (batch.length) await flush();
        } finally { lines.close(); input.destroy(); }
        if (count !== entry.expected.rows || hash.digest('hex') !== entry.expected.sha256) throw new Error('Archivo cambió durante COPY');
        const result = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM ' + relation(entry.table));
        if (Number(result.rows[0]?.count) !== count) throw new Error('Conteo posterior inconsistente');
      }
    }
    signal.throwIfAborted();
    for (const [index, group] of plan.entries()) {
      await record({ service: group.service, state: 'commit-started' });
      await clients[index]!.query('COMMIT');
      await record({ service: group.service, state: 'committed' });
    }
    return { dataset: manifest.id, rows: manifest.totalRows, elapsedMs: Math.round(performance.now() - start) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    await record({ state: 'failed', reason: code === '23505' ? 'duplicado' : signal.aborted ? 'interrumpido' : 'revisar estado por servicio' });
    throw new Error(code === '23505' ? 'COPY rechazó una clave duplicada' : 'COPY interrumpido o rechazado. Consulta el journal');
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    await journal.close();
  }
}

const integritySql = {
  central: [
    `SELECT count(*)::int AS invalid FROM public."Appointment" a JOIN public."ServiceRequest" r ON a."requestId"=r.id JOIN public."RequestContext" c ON c."requestId"=r.id WHERE a."patientId"<>r."patientId" OR r.status<>'COMPLETED' OR r.version<>4 OR r."currentStep"<>'CONFIRMED' OR c.data->>'studyId' IS DISTINCT FROM a."studyId"::text OR c.data->>'clinicId' IS DISTINCT FROM a."clinicId"::text OR (c.data->>'scheduledAt')::timestamptz IS DISTINCT FROM a."scheduledAt"`,
    `SELECT count(*)::int AS invalid FROM public."Appointment" a WHERE NOT EXISTS (SELECT 1 FROM public."DomainEvent" e WHERE e."requestId"=a."requestId" AND e."patientId"=a."patientId" AND e.type='APPOINTMENT_CONFIRMED' AND e.payload->>'appointmentId'=a.id::text AND e.payload->>'version'='4')`,
  ],
  orchestrator: [
    `SELECT count(*)::int AS invalid FROM public."Journey" j LEFT JOIN public."JourneyContext" c ON c."journeyId"=j.id WHERE c."journeyId" IS NULL OR c.version<>2 OR c."currentStep"<>'SELECT_CLINIC' OR NOT EXISTS (SELECT 1 FROM public."JourneyEvent" e WHERE e."journeyId"=j.id AND e.type='JOURNEY_CREATED' AND e.payload->>'version'='1') OR NOT EXISTS (SELECT 1 FROM public."JourneyEvent" e WHERE e."journeyId"=j.id AND e.type='JOURNEY_CONTEXT_UPDATED' AND e.payload->>'version'='2')`,
    `SELECT count(*)::int AS invalid FROM (SELECT "producerId","externalEventId" FROM public."JourneyEvent" GROUP BY 1,2 HAVING count(*)>1) AS duplicates`,
  ],
};

export async function inspectCopy(directory: string, env: NodeJS.ProcessEnv, mode: 'before' | 'after') {
  const manifest = await validateDataset(directory);
  const plan = planCopy(manifest, 1000).filter(group => group.order.length);
  const journal = mode === 'after'
    ? (await readFile(resolve(directory, 'copy-journal.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { dataset: string; service?: string; state: string; rows?: number; table?: string })
    : [];
  const verified = [];
  for (const group of plan) {
    const key = group.service === 'central' ? 'SIM_CENTRAL_DATABASE_URL' : 'SIM_ORCHESTRATOR_DATABASE_URL';
    const client = new pg.Client({ connectionString: copyTarget(env[key], group.service, env),
      connectionTimeoutMillis: 5000, statement_timeout: 60_000 });
    try {
      await client.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await verifyDatabase(client, group, mode === 'before', false);
      if (mode === 'after') {
        const records = journal.filter(row => row.service === group.service);
        if (!records.some(row => row.dataset === manifest.id && row.state === 'committed')) throw new Error('Journal sin commit');
        const rowCounts: Record<string, number> = {};
        for (const entry of group.order) {
          const result = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM ' + relation(entry.table));
          const count = Number(result.rows[0]?.count);
          const logged = records.filter(row => row.table === entry.table && row.state === 'provisional')
            .reduce((sum, row) => sum + (row.rows ?? 0), 0);
          if (count !== entry.expected.rows || logged !== count) throw new Error('Conteos de COPY incompatibles');
          rowCounts[entry.table] = count;
        }
        if (manifest.totalRows >= 23) {
          for (const source of integritySql[group.service]) {
            const result = await client.query<{ invalid: number }>(source);
            if (result.rows[0]?.invalid !== 0) throw new Error('Integridad de negocio incompatible');
          }
        }
        verified.push({ service: group.service, counts: rowCounts, journal: 'committed',
          integrityChecks: manifest.totalRows >= 23 ? 2 : 0 });
      } else verified.push({ service: group.service, synthetic: true, schema: manifest.schemaSha.slice(0, 7), tablesEmpty: true });
      await client.query('COMMIT');
    } finally { await client.end().catch(() => {}); }
  }
  return { dataset: manifest.id, services: verified, mode };
}