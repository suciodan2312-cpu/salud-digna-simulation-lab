import { compareCentralContract } from './contracts/deployed.js';
import { labPlan } from './local-plan.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { reviewContracts } from './contracts/review.js';
import { CapabilityError, object, timestamp } from './contracts/index.js';
import { validateDataset, generateDataset } from './data/dataset.js';
import { referenceDate, schemaSha } from './data/corpus.js';
import { inspectCopy, loadCopy, planCopy } from './data/copy.js';
import { loadNames, readLoadPlan, arrivalLevels } from './load/plan.js';
import { formatReports, reportMetadata } from './reports/format.js';
import type { Config } from './config/index.js';

const commands = ['check-config', 'check-contracts', 'dataset-generate', 'dataset-validate', 'copy-plan',
  'copy-load', 'copy-preflight', 'copy-audit', 'k6-plan', 'report', 'lab-plan', 'compare-contracts'] as const;
export function isExtraCommand(value: string): value is typeof commands[number] {
  return commands.some(command => command === value);
}
export async function runExtraCommand(command: typeof commands[number], config: Config,
  env = process.env, arg = process.argv[3]) {
  const output = 'reports';
  if (command === 'check-config') {
    return { environment: config.environment, seed: config.seed, records: config.records,
      capabilities: config.capabilities, writes: config.allowWrites, channels: config.enabledChannels,
      concurrency: config.concurrency, interfaces: Object.fromEntries(Object.entries(config.interfaces).map(([key, value]) => [key, Boolean(value)])), schemaSha };
  }
  if (command === 'check-contracts') return reviewContracts();
  if (command === 'lab-plan') return labPlan;
  if (command === 'compare-contracts') {
    if (!arg || /^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) throw new CapabilityError('archivo local OpenAPI');
    return compareCentralContract(arg);
  }
  if (command === 'k6-plan') return { levels: arrivalLevels, ...readLoadPlan({ ...env, SIM_LOAD_SCENARIO: arg ?? env.SIM_LOAD_SCENARIO }) };
  if (command === 'dataset-generate') {
    const { manifest, reused } = await generateDataset(resolve(output, 'datasets'), config.seed, config.records,
      env.SIM_REFERENCE_DATE ?? referenceDate);
    return { reused, manifest };
  }
  if (command === 'report') {
    if (!arg || !loadNames.some(name => arg === name)) throw new CapabilityError('escenario de reporte');
    const report = object(JSON.parse(await readFile(resolve(output, 'k6-' + arg + '.json'), 'utf8')) as unknown);
    const metadata = object(report.metadata);
    if (typeof metadata.seed !== 'number' || !Number.isInteger(metadata.seed) ||
        typeof metadata.code !== 'string' || (metadata.dataset !== null && typeof metadata.dataset !== 'string')) {
      throw new Error('Metadata de reporte inválida');
    }
    const clean = reportMetadata(arg, metadata.seed, { SIM_ENV: metadata.environment === 'test' ? 'test' : 'local',
      SIM_CODE_REVISION: metadata.code, SIM_DATASET_ID: metadata.dataset ?? undefined });
    if (metadata.finishedAt !== undefined) clean.finishedAt = timestamp(metadata.finishedAt);
    if (metadata.durationMs === null || (typeof metadata.durationMs === 'number' &&
      Number.isFinite(metadata.durationMs) && metadata.durationMs >= 0)) clean.durationMs = metadata.durationMs;
    if (metadata.configuration !== undefined) {
      const options = object(metadata.configuration);
      const { executor, timeoutMs, preAllocatedVUs, maxVUs, rate } = options;
      if (typeof executor !== 'string' || !['shared-iterations', 'per-vu-iterations', 'constant-arrival-rate',
        'ramping-arrival-rate'].includes(executor) || typeof timeoutMs !== 'number' ||
        typeof preAllocatedVUs !== 'number' || typeof maxVUs !== 'number' || (rate !== null && typeof rate !== 'number')) {
        throw new Error('Configuración de reporte inválida');
      }
      clean.configuration = { executor, timeoutMs, preAllocatedVUs, maxVUs, rate };
    }
    return JSON.parse(formatReports(clean, object(report.metrics) as Record<string, { values?: Record<string, unknown> }>).json) as unknown;
  }
  if (!arg || !/^[a-f0-9]{24}$/.test(arg)) throw new CapabilityError('ID de dataset');
  const directory = resolve(output, 'datasets', arg);
  const batchRows = env.SIM_COPY_BATCH === undefined ? 1000 : Number(env.SIM_COPY_BATCH);
  if (command === 'copy-preflight' || command === 'copy-audit') {
    return inspectCopy(directory, env, command === 'copy-preflight' ? 'before' : 'after');
  }
  if (command === 'copy-load') {
    if (env.SIM_COPY_CONFIRM !== 'salud-digna:synthetic-only' || config.environment !== 'local') {
      throw new CapabilityError('autorización explícita COPY');
    }
    if (!Number.isInteger(batchRows) || batchRows < 1 || batchRows > 10_000) throw new Error('SIM_COPY_BATCH inválido');
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try { return await loadCopy(directory, batchRows, env, controller.signal); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  const manifest = await validateDataset(directory, arg);
  return command === 'dataset-validate' ? manifest
    : { dataset: manifest.id, dryRun: true, batchRows, tables: planCopy(manifest, batchRows) };
}
