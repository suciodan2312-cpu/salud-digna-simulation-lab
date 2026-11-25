import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corpus, copyLine, fileName, services, tableEntries, type Row } from '../data/corpus.js';
import { generateDataset, validateDataset } from '../data/dataset.js';
import { copyTarget, planCopy } from '../data/copy.js';
import { arrivalLevels, loadNames, loadPermission, readLoadPlan } from '../load/plan.js';
import { formatReports, reportMetadata } from '../reports/format.js';
import { frustrated } from '../engine/behavior.js';
import { CentralApi, type CentralSession } from '../adapters/central-api/index.js';
import type { Request, Transport } from '../adapters/transport/index.js';
import { HttpError, type Decoder } from '../contracts/index.js';
import { reviewContracts } from '../contracts/review.js';

test('Faker corpus repeats, preserves exact counts and can stream a five-million target', () => {
  assert.deepEqual([...corpus(42, 80)], [...corpus(42, 80)]);
  assert.notDeepEqual([...corpus(42, 80)], [...corpus(43, 80)]);
  for (const count of [1, 20, 22, 23, 24, 431]) assert.equal([...corpus(42, count)].length, count);
  const stream = corpus(42, 5_000_000);
  for (let i = 0; i < 64; i++) assert.equal(stream.next().done, false);
  stream.return(undefined);
  assert.equal(copyLine(['a\tb', null, { text: 'a\\b' }]), 'a\\tb\t\\N\t{"text":"a\\\\\\\\b"}\n');
});
test('corpus tables use only local references and satisfy relation and uniqueness rules', () => {
  const rows = [...corpus(7, 1000)];
  const by = (service: Row['service'], table: string) =>
    new Map(rows.filter(row => row.service === service && row.table === table).map(row => [row.values[0], row.values]));
  for (const service of services) {
    for (const [table, columns] of tableEntries(service)) {
      const matching = rows.filter(row => row.service === service && row.table === table);
      assert.equal(by(service, table).size, matching.length);
      assert.ok(matching.every(row => row.values.length === columns.split(' ').length));
    }
  }
  const patients = by('central', 'Patient'), requests = by('central', 'ServiceRequest');
  const users = by('central', 'User'), clinics = by('central', 'Clinic'), studies = by('central', 'Study');
  const appointments = by('central', 'Appointment'), journeys = by('orchestrator', 'Journey');
  const subjects = by('orchestrator', 'PatientSubject'), channels = by('orchestrator', 'Channel');
  const appointmentRequests = new Set();
  for (const appointment of appointments.values()) {
    assert.equal(requests.get(appointment[1])?.[1], appointment[2]);
    assert.ok(patients.has(appointment[2]) && clinics.has(appointment[3]) && studies.has(appointment[4]));
    assert.equal(requests.get(appointment[1])?.[3], 'COMPLETED');
    assert.ok(!appointmentRequests.has(appointment[1]));
    appointmentRequests.add(appointment[1]);
  }
  for (const user of users.values()) {
    assert.match(String(user[1]), /@example\.test$/);
    if (user[2] === 'PATIENT') assert.ok(patients.has(user[3]));
  }
  for (const event of by('central', 'DomainEvent').values()) {
    assert.equal(requests.get(event[1])?.[1], event[2]);
    assert.equal(users.get(event[5])?.[3], event[2]);
    if (event[3] === 'APPOINTMENT_CONFIRMED') assert.ok(appointments.has((event[6] as { appointmentId: string }).appointmentId));
  }
  for (const id of subjects.keys()) assert.ok(!patients.has(id));
  for (const [id, journey] of journeys) {
    assert.ok(!requests.has(id) && subjects.has(journey[1]));
    assert.ok(by('orchestrator', 'JourneyContext').has(id));
  }
  const events = new Set<string>();
  for (const event of by('orchestrator', 'JourneyEvent').values()) {
    assert.ok(journeys.has(event[1]) && channels.has(event[2]));
    const key = String(event[2]) + ':' + String(event[3]);
    assert.ok(!events.has(key));
    events.add(key);
  }
});
test('dataset files are reusable, COPY is ordered and tampering is rejected offline', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'simulation-fixture-'));
  try {
    const created = await generateDataset(folder, 71, 439);
    assert.equal(created.manifest.totalRows, 439);
    assert.equal((await generateDataset(folder, 71, 439)).reused, true);
    const plan = planCopy(await validateDataset(created.directory), 10);
    const central = plan[0]!.order;
    assert.ok(central.findIndex(item => item.table === 'Patient') < central.findIndex(item => item.table === 'ServiceRequest'));
    assert.match(central[0]!.sql, /COPY public\."Patient".*FROM STDIN/);
    assert.ok(central.every(entry => entry.batches === Math.ceil(entry.expected.rows / 10)));
    assert.throws(() => planCopy(created.manifest, 0));
    await appendFile(join(created.directory, fileName('central', 'Patient')), 'fixture corruption\n');
    await assert.rejects(validateDataset(created.directory), /alterado/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('COPY and k6 reject remote or unconfirmed destinations without echoing secrets', () => {
  const marker = { SIM_ENV: 'local', SIM_COPY_CONFIRM: 'salud-digna:synthetic-only' };
  const secret = 'fixture-secret';
  const local = 'postgresql://fixture:' + secret + '@127.0.0.1:5432/salud_digna_simulation';
  assert.equal(copyTarget(local, 'central', marker), local);
  assert.throws(() => copyTarget(local.replace('127.0.0.1', 'example.test'), 'central', marker),
    (error: unknown) => error instanceof Error && !error.message.includes(secret));
  assert.throws(() => copyTarget(local, 'central', { ...marker, SIM_ENV: 'test' }));
  assert.throws(() => copyTarget(local, 'orchestrator', marker));
  const plan = readLoadPlan({});
  assert.throws(() => loadPermission({}, plan));
  assert.throws(() => loadPermission({ SIM_ENV: 'local', SIM_K6_CONFIRM: 'isolated-loopback',
    SIM_CENTRAL_URL: 'http://fixture-secret@example.test' }, plan),
  (error: unknown) => error instanceof Error && !error.message.includes(secret));
  assert.throws(() => loadPermission({ SIM_ENV: 'local', SIM_K6_CONFIRM: 'isolated-loopback' },
    readLoadPlan({ SIM_LOAD_SCENARIO: 'idempotency' })));
});
test('k6 plans separate arrivals from restricted one-shot journeys', () => {
  for (const name of loadNames) assert.equal(readLoadPlan({ SIM_LOAD_SCENARIO: name }).name, name);
  for (const rate of arrivalLevels) {
    const job = readLoadPlan({ SIM_LOAD_SCENARIO: 'habitual', SIM_RATE: String(rate) }).executor;
    assert.equal(job.executor, 'constant-arrival-rate');
    assert.equal(job.rate, rate);
  }
  const continuity = readLoadPlan({ SIM_LOAD_SCENARIO: 'continuity', SIM_RATE: '1000' }).executor;
  assert.equal(continuity.executor, 'shared-iterations');
  assert.equal(continuity.iterations, 1);
  assert.throws(() => readLoadPlan({ SIM_RATE: '1001' }));
  assert.throws(() => readLoadPlan({ SIM_PRE_VUS: '99', SIM_VUS: '2' }));
});
test('reports export observed numeric metrics and discard credentials and absent metrics', () => {
  const metadata = reportMetadata('smoke', 42, { SIM_ENV: 'local', SIM_PATIENT_TOKEN: 'fixture-secret' });
  const report = formatReports(metadata, { http_reqs: { values: { count: 5, rate: 2, token: 'fixture-secret' } },
    http_req_duration: { values: { 'p(95)': 7 } }, secret: { values: { count: 1 } } });
  assert.match(report.csv, /"http_reqs","rate","2"/);
  assert.deepEqual(JSON.parse(report.json).metrics.http_reqs, { count: 5, rate: 2 });
  assert.ok(!report.json.includes('fixture-secret') && !report.csv.includes('secret'));
  assert.equal(JSON.parse(report.json).metrics.simulation_appointments, null);
});
test('sustained read summaries preserve only the measured operation tags', () => {
  const metadata = reportMetadata('habitual', 42, { SIM_CODE_REVISION: 'c0ca036+simulation-phase7' });
  const tag = 'http_reqs{name:central.pending}';
  const input = { [tag]: { values: { count: 3 } }, 'http_reqs{name:private}': { values: { count: 1 } } };
  const report = JSON.parse(formatReports(metadata, input).json);
  assert.equal(report.metrics[tag].count, 3);
  assert.equal(report.metrics['http_reqs{name:central.appointments}'], null);
  assert.ok(!JSON.stringify(report).includes('private'));
});

test('frustration differentiates a synthetic event from an observed conflict and recovers', async () => {
  const fixtureId = '00000000-0000-4000-8000-000000000001';
  const snapshot = { id: fixtureId, status: 'DRAFT', currentStep: 'SELECT_STUDY', lastChannel: 'WEB',
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
    type: 'APPOINTMENT', version: 1, context: {}, completedAt: null };
  let reads = 0;
  const fake: Transport = { async send<T>(request: Request, decode: Decoder<T>) {
    if (request.operation === 'central.pending') return decode({ items: [snapshot], page: 1, limit: 1, hasMore: false });
    if (request.operation === 'central.read') return decode(snapshot);
    assert.equal(request.operation, 'central.resume');
    if (++reads === 1) throw new HttpError(409);
    return decode(snapshot);
  } };
  const session: CentralSession = { role: 'PATIENT', token: 'fixture', expiresAt: '2099-01-01T00:00:00.000Z' };
  let now = 0;
  const state = await frustrated(new CentralApi(fake, false), session, { initial: 0, seed: 1, retryBudget: 2,
    delayMs: 50, canConverse: false, injectedEvent: 'delay', timing: { now: () => now, wait: async ms => { now += ms; } } });
  assert.deepEqual(state.trace.map(item => [item.origin, item.event, item.decision]),
    [['injected', 'delay', 'retry'], ['observed', 'conflict', 'retry'], ['observed', 'reread', 'reread']]);
  assert.equal(state.conflicts, 1);
  assert.equal(state.requestErrors, 0);
  assert.ok(state.resolvedMs !== undefined);
});
test('audited static routes are present and k6 imports avoid Node modules', async () => {
  const review = await reviewContracts();
  assert.ok(review.centralRoutes > 20 && review.orchestratorOperations > 5);
  const checked = new Set<string>();
  async function visit(file: URL) {
    if (checked.has(file.href)) return;
    checked.add(file.href);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import) ['"]([^'"]+)['"]/g)) {
      const dependency = match[1]!;
      if (dependency.startsWith('k6')) continue;
      assert.ok(dependency.startsWith('.'), dependency);
      await visit(new URL(dependency, file));
    }
  }
  await visit(new URL('../load/main.js', import.meta.url));
});
