import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { datasetId, schemaSha, services, tableEntries } from '../dist/data/corpus.js';
import { databases, readLabUrl } from '../dist/local/monitor.js';
import { localTarget, targets } from '../dist/local/targets.js';

assert.equal(localTarget, targets['integration-5m']);
const id = localTarget.dataset;
const dir = '/var/lib/sd-lab/reports/datasets/' + id;
const manifest = JSON.parse(await readFile(dir + '/manifest.json', 'utf8'));
assert.equal(manifest.id, id);
assert.equal(manifest.schemaSha, schemaSha);
assert.equal(manifest.totalRows, 5000000);
assert.equal(datasetId(manifest.seed, manifest.totalRows, manifest.referenceDate), id);
const journal = (await readFile(dir + '/copy-journal.jsonl', 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
await databases();
let total = 0;
for (const service of services) {
  assert(journal.some(row => row.dataset === id && row.service === service && row.state === 'committed'));
  const central = service === 'central';
  const owner = central ? 'sim_central_app' : 'salud_digna_orchestrator_app';
  const client = new pg.Client({connectionString: readLabUrl(service), connectionTimeoutMillis: 3000});
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const role = await client.query("SELECT current_user AS role, pg_get_userbyid(datdba) AS owner, current_setting('server_version_num')::int / 10000 AS major FROM pg_database WHERE datname=current_database()");
    assert.deepEqual(role.rows[0], {role: owner, owner, major: 18});
    const bad = await client.query("SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated");
    assert.equal(bad.rows[0].n, 0);
    const prefix = manifest.seed.toString(16).padStart(8, '0') + (central ? '-c001-' : '-d001-') + '%';
    for (const [table, columns] of tableEntries(service)) {
      const key = columns.split(' ')[0];
      const rows = await client.query('SELECT count(*)::int AS n FROM public."' + table + '" WHERE "' + key + '"::text LIKE $1', [prefix]);
      assert.equal(rows.rows[0].n, manifest.tables[service][table].rows, service + '.' + table);
      total += rows.rows[0].n;
    }
    await client.query('COMMIT');
  } finally { await client.end(); }
}
assert.equal(total, 5000000);
console.log('Corpus histórico verificado: ' + total);
