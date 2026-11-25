import { readdir, readFile } from 'node:fs/promises';
import { runId, type ExecutionState } from './control.js';

async function status(id: string) {
  const safe = runId(id);
  const resource = JSON.parse(await readFile('reports/phase4-' + safe + '-resources.json', 'utf8')) as {
    state: ExecutionState; dataset: string; startedAt?: string; finishedAt?: string;
    integrity?: string; samples?: unknown[]; stopReason?: string | null;
  };
  if (!/^[a-f0-9]{24}$/.test(resource.dataset)) throw new Error('Dataset incompatible');
  const metricsFile = 'reports/k6-phase4-' + safe + '.json';
  const measured = await readFile(metricsFile, 'utf8').then(raw => {
    const { metrics } = JSON.parse(raw) as { metrics: Record<string, Record<string, number> | null> };
    return { iterations: metrics.iterations?.count ?? null, requests: metrics.http_reqs?.count ?? null,
      dropped: metrics.dropped_iterations?.count ?? null, p95Ms: metrics.http_req_duration?.['p(95)'] ?? null };
  }, () => null);
  return { id: safe, kind: 'performance-real', scenario: 'read-baseline', dataset: resource.dataset, state: resource.state,
    progress: resource.state === 'completed' ? 1 : null, startedAt: resource.startedAt ?? null,
    finishedAt: resource.finishedAt ?? null, metrics: measured, sampleCount: resource.samples?.length ?? null,
    integrity: resource.integrity ?? null, stopReason: resource.stopReason ?? null };
}
async function main() {
  const command = process.argv[2];
  if (command === 'status') return status(runId(process.argv[3]));
  if (command !== 'list') throw new Error('Operación desconocida');
  const names = (await readdir('reports')).flatMap(name => {
    const match = /^phase4-([a-z0-9][a-z0-9-]{0,47})-resources\.json$/.exec(name);
    return match?.[1] ? [match[1]] : [];
  }).sort();
  return Promise.all(names.map(status));
}
main().then(value => console.log(JSON.stringify(value, null, 2)))
  .catch(() => { console.error('Consulta de ejecución no disponible'); process.exitCode = 1; });
