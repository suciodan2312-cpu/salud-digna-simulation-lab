import { execFileSync, spawn } from 'node:child_process';
import { freemem } from 'node:os';
import { once } from 'node:events';
import { access, statfs, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CentralApi } from '../adapters/central-api/index.js';
import { Orchestrator } from '../adapters/orchestrator/index.js';
import { HttpTransport } from '../adapters/transport/index.js';
import { readConfig } from '../config/index.js';
import { readLoadPlan, warmReadVUs } from '../load/plan.js';
import { basic } from '../scenarios/index.js';
import { centralOrigin, databases, localPids, orchestratorOrigin, resources } from './monitor.js';
import { verifyBindings, runId } from './control.js';

import { localTarget, stagedTarget } from './targets.js';
import { partialRun } from './partial.js';

const dataset = localTarget.dataset;
function approvedRun() {
  if (!stagedTarget) {
    if (process.env.SIM_BASELINE_APPROVAL !== 'read-five-for-thirty') throw new Error('Autorización requerida');
    return { phase: 'phase4', rate: 5, seconds: 30, vus: 5 };
  }
  const rate = Number(process.env.SIM_STAGE_RATE ?? '5');
  const seconds = Number(process.env.SIM_STAGE_SECONDS ?? '60');
  const vus = Number(process.env.SIM_STAGE_VUS ?? '5');
  if (process.env.SIM_PHASE7 === 'true') {
    const key = [rate, seconds, vus].join(':');
    if (process.env.SIM_LOCAL_LAB !== 'corpus-5m' || !['25:300:10', '50:300:20', '100:120:20'].includes(key) ||
        process.env.SIM_BASELINE_APPROVAL !== key) throw new Error('Plan sostenido sin autorización');
    return { phase: 'phase7', rate, seconds, vus };
  }
  if (![5, 10, 25, 50, 100].includes(rate) || ![30, 60, 300, 600].includes(seconds) || ![2, 5, 10, 20].includes(vus) ||
      process.env.SIM_BASELINE_APPROVAL !== [rate, seconds, vus].join(':')) throw new Error('Autorización exacta requerida');
  return { phase: process.env.SIM_PHASE6 === 'true' ? 'phase6' : 'phase5', rate, seconds, vus };
}
function assertLocal() {
  const config = readConfig();
  if (config.environment !== 'local' || config.central !== centralOrigin || config.orchestrator !== orchestratorOrigin) {
    throw new Error('Solo se admite el laboratorio local');
  }
  return config;
}
async function preflight() {
  const config = assertLocal();
  const pids = await localPids();
  await verifyBindings(pids);
  const database = await databases(process.env, true);
  const local = { ...config, allowWrites: false, retries: 0 };
  const central = new CentralApi(new HttpTransport(config.central, local), false);
  const orchestration = new Orchestrator(new HttpTransport(config.orchestrator, local), [], false);
  const health = await basic(central, orchestration);
  if (!health.catalogReady) throw new Error('Catálogos sin datos');
  const capability = (key: string) => process.env[key] ?? '';
  const email = capability('SIM_PATIENT_EMAIL');
  if (!email.endsWith('@example.test') || !capability('SIM_PATIENT_PASSWORD')) throw new Error('Cuenta ficticia requerida');
  return { config, pids, database, health, email };
}

async function execute() {
  const command = process.argv[2];
  if (command === 'preflight') {
    const check = await preflight();
    console.log(JSON.stringify({ dataset, health: check.health, database: check.database,
      resources: await resources(check.pids), accountFixtureConfigured: true }, null, 2));
    return;
  }
  if (command !== 'run') throw new Error('Autorización requerida');
  const selected = approvedRun();
  const id = runId(process.argv[3]);
  const check = await preflight();
  const root = join('reports', selected.phase + '-' + id);
  const evidence = root + '-resources.json';
  const requiredJournal = await readFile('reports/datasets/' + dataset + '/copy-journal.jsonl', 'utf8');
  const committed = requiredJournal.trim().split('\n').map(line => JSON.parse(line) as
    { state?: string; service?: string; dataset?: string }).filter(row => row.dataset === dataset && row.state === 'committed');
  if (new Set(committed.map(row => row.service)).size !== 2) throw new Error('Corpus sin commits verificados');
  const exe = join(process.env.LOCALAPPDATA ?? '', 'SaludDignaSimulation', 'k6-v1.8.2',
    'k6-v1.8.2-windows-amd64', 'k6.exe');
  await access(exe);
  const borrower = new CentralApi(new HttpTransport(check.config.central, { ...check.config, allowWrites: true, retries: 0 }), false);
  const pool = [{ email: check.email, password: process.env.SIM_PATIENT_PASSWORD! }];
  const privateActors = await readFile(localTarget.folder + '/actors-pool.jsonl', 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  for (const line of privateActors.trim().split('\n').filter(Boolean)) {
    const actor = JSON.parse(line) as { email?: string; password?: string };
    if (!actor.email?.endsWith('@example.test') || !actor.password || pool.some(p => p.email === actor.email) || pool.length >= 5) {
      throw new Error('Pool de pacientes incompatible');
    }
    pool.push({ email: actor.email, password: actor.password });
  }
  const sessions = [];
  for (const actor of pool) sessions.push(await borrower.login(actor.email, actor.password, 'PATIENT'));
  const session = sessions[0]!;
  if ((await borrower.me(session)).role !== 'PATIENT' || Date.parse(session.expiresAt) < Date.now() + (selected.seconds + 45) * 1000) {
    throw new Error('Sesión ficticia insuficiente');
  }
  const startedAt = new Date().toISOString();
  await writeFile(evidence, JSON.stringify({ state: 'starting', dataset, startedAt }), { flag: 'wx' });
  const sustained = selected.phase === 'phase7';
  const revision = sustained ? execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim() : 'ff989cc';
  const codeRevision = revision + '+simulation-' + selected.phase;
  // The previous 100/s run dropped arrivals before the first VU sample. Initialize the approved budget up front.
  const warmVUs = sustained ? selected.vus : warmReadVUs(selected.rate, selected.vus);
  const env = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    SIM_ENV: 'local', SIM_CENTRAL_URL: centralOrigin, SIM_ORCHESTRATOR_URL: orchestratorOrigin,
    SIM_K6_CONFIRM: 'isolated-loopback', SIM_LOAD_SCENARIO: 'habitual', SIM_RATE: String(selected.rate),
    SIM_DURATION_SECONDS: String(selected.seconds), SIM_PRE_VUS: String(warmVUs), SIM_VUS: String(selected.vus), SIM_MAX_DROPPED: '0',
    SIM_SEED: process.env.SIM_STAGE_SEED ?? '42', SIM_CITAS_PERCENT: process.env.SIM_STAGE_CITAS ?? '50', SIM_STOP_DELAY_SECONDS: '2', SIM_P95_MS: '500', SIM_ERROR_PERCENT: '1', SIM_PATIENT_READ_PERCENT: '100',
    SIM_PATIENT_TOKEN: session.token, SIM_PATIENT_EXPIRES_AT: session.expiresAt,
    SIM_PATIENT_SESSIONS: JSON.stringify(sessions), SIM_IDENTITY_COUNT: String(sessions.length),
    SIM_DATASET_ID: dataset, SIM_CODE_REVISION: codeRevision, SIM_RUN_ID: selected.phase + '-' + id,
    K6_WEB_DASHBOARD: 'true', K6_WEB_DASHBOARD_PORT: '-1', K6_WEB_DASHBOARD_PERIOD: '2s',
    K6_WEB_DASHBOARD_EXPORT: root + '.html',
  };
  const plan = readLoadPlan(env);
  const minimumFree = (sustained ? 1024 : 512) * 1024 * 1024;
  const systemBefore = await resources(check.pids);
  if (systemBefore.freeMemoryBytes < minimumFree || systemBefore.diskFreeBytes < minimumFree) throw new Error('Recursos insuficientes');
  const samples = [{ system: systemBefore, database: check.database }];
  const child = spawn(exe, ['run', '--no-usage-report', '--out', 'json=' + root + '-timeline.jsonl', 'dist/load/main.js'], { env, stdio: 'inherit', windowsHide: true });
  const done = once(child, 'close') as Promise<[number | null, string | null]>;
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  process.once('SIGINT', stop);
  let stopReason: string | null = null;
  const watch = setTimeout(() => { stopReason = 'elapsed-limit'; stop(); }, (selected.seconds + 40) * 1000);
  await writeFile(evidence, JSON.stringify({ state: 'running', dataset, startedAt }));
  let tracking = true;
  const collectorMs: number[] = [];
  // Keep inexpensive safety checks active while the first k6 iteration starts.
  // Avoid starting PowerShell/CIM at the same instant as the load generator.
  const guard = sustained ? setInterval(async () => {
    try {
      const drive = await statfs('.');
      if (freemem() < minimumFree || drive.bavail * drive.bsize < minimumFree) {
        stopReason = 'resource-limit'; stop();
      }
    } catch { stopReason = 'resource-monitor'; stop(); }
  }, 500) : undefined;
  const collect = async () => {
    if (sustained) await delay(1500);
    while (tracking) {
      try {
        await access(root + '.stop');
        stopReason = 'operator';
        stop();
      } catch { /* No cancellation request. */ }
      try {
        const begin = performance.now();
        const system = await resources(check.pids, child.pid);
        if (system.freeMemoryBytes < minimumFree || system.diskFreeBytes < minimumFree) {
          stopReason = 'resource-limit';
          stop();
        }
        const database = await databases();
        samples.push({ system, database });
        collectorMs.push(performance.now() - begin);
        if (sustained && (database.central.blockedLocks || database.orchestrator.blockedLocks)) {
          stopReason = 'blocked-lock'; stop();
        }
      } catch { if (sustained) { stopReason = 'resource-monitor'; stop(); } }
      await delay(4500);
    }
  };
  const collecting = collect();
  let code: number | null = null;
  let signal: string | null = null;
  try {
    [code, signal] = await done;
    if (stagedTarget && (stopReason === 'operator' || (sustained && stopReason))) {
      await partialRun(root + '-timeline.jsonl', { scenario: 'habitual', seed: plan.seed, authenticatedIdentities: sessions.length,
        code: codeRevision, dataset, environment: 'local',
        finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt),
        configuration: { executor: 'constant-arrival-rate', timeoutMs: plan.timeout,
          preAllocatedVUs: warmVUs, maxVUs: selected.vus, rate: selected.rate } });
    }
  } finally {
    clearTimeout(watch);
    clearInterval(guard);
    tracking = false;
    process.off('SIGINT', stop);
    await collecting;
    const after = await databases(process.env, true);
    const countsBefore = Object.fromEntries(Object.entries(check.database).map(([s, row]) => [s, row.counts]));
    const countsAfter = Object.fromEntries(Object.entries(after).map(([s, row]) => [s, row.counts]));
    const integrity = JSON.stringify(countsBefore) === JSON.stringify(countsAfter) ? 'counts-unchanged' : 'counts-changed';
    await writeFile(evidence, JSON.stringify({ state: stopReason === 'operator' ? 'cancelled' : sustained && code === 99 ? 'threshold-stopped' : code === 0 && !stopReason && integrity === 'counts-unchanged' ? 'completed' : 'failed',
      kind: 'performance-real', dataset, plan, authenticatedIdentities: sessions.length, startedAt, finishedAt: new Date().toISOString(), stopReason, exitCode: code, signal, integrity, collectorMs, samples, after }, null, 2));
    if (stopReason || code !== 0 || integrity !== 'counts-unchanged') process.exitCode = 1;
  }
}
async function main() {
  if (!stagedTarget || process.argv[2] !== 'run') return execute();
  const lockPath = 'reports/phase5-execution.lock';
  const lock = await open(lockPath, 'wx');
  try { await execute(); } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
main().catch(() => { console.error('El laboratorio o la ejecución no superaron la validación local.'); process.exitCode = 1; });
