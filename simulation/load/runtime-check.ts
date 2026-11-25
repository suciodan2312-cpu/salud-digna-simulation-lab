import { formatReports } from '../reports/format.js';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { CentralApi } from '../adapters/central-api/index.js';
import { localOrigin, loadNames, readLoadPlan } from './plan.js';

// No HTTP module or callable network transport in this fixture.
const marker = new Counter('fixture_runtime_checks');
export const options = { vus: 1, iterations: 1 };
export default async function () {
  for (const name of loadNames) {
    if (readLoadPlan({ SIM_LOAD_SCENARIO: name }).name !== name) throw new Error('Plan incompatible');
  }
  if (localOrigin('http://127.0.0.1:13100') !== 'http://127.0.0.1:13100') throw new Error('Origen incompatible');
  const api = new CentralApi({ send: async (_request, decode) => decode({ status: 'ok' }) }, false);
  if (await api.health() !== 'ok') throw new Error('Adaptador incompatible con el runtime');
  marker.add(1);
  sleep(4);
}
export function handleSummary(data: { state?: { testRunDurationMs?: number } }) {
  const report = formatReports({ scenario: 'fixture-runtime-offline', seed: 42,
    code: 'ff989cc+simulation-phase3', dataset: null, environment: 'local',
    finishedAt: new Date().toISOString(), durationMs: data.state?.testRunDurationMs ?? null }, {});
  return { 'reports/k6-runtime-fixture.json': report.json, 'reports/k6-runtime-fixture.csv': report.csv,
    stdout: 'Fixture de runtime k6 sin peticiones HTTP.\n' };
}