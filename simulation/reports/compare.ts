import { readFile, writeFile } from 'node:fs/promises';
import { runId } from '../local/control.js';

type Stat = Record<string, number | undefined> | null;
type Sample = { system: Record<string, unknown> };
const load = async (path: string) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
export async function compareBaseline(id: string) {
  const safe = runId(id);
  const rows = [];
  for (const name of ['smoke', 'phase4-' + safe]) {
    const { metadata, metrics } = await load('reports/k6-' + name + '.json') as {
      metadata: { dataset: string; code: string; scenario: string; finishedAt?: string; durationMs?: number; configuration?: { rate?: number } };
      metrics: Record<string, Stat>;
    };
    if (!/^[a-f0-9]{24}$/.test(metadata.dataset)) throw new Error('Dataset desconocido');
    const manifest = await load('reports/datasets/' + metadata.dataset + '/manifest.json') as {
      tables: Record<string, Record<string, { rows: number }>>;
    };
    const evidence = name === 'smoke' ? null : await load('reports/' + name + '-resources.json') as {
      integrity: string; samples: Sample[];
    };
    const stat = (metric: string, key: string) => metrics[metric]?.[key] ?? null;
    const peak: Record<string, number | null> = {};
    for (const key of ['central', 'orchestrator', 'postgres', 'k6']) {
      const rss = (evidence?.samples ?? []).flatMap(({ system }) => {
        const group = system[key] as { residentBytes?: number } | null;
        return typeof group?.residentBytes === 'number' ? [group.residentBytes] : [];
      });
      peak[key] = rss.length ? Math.max(...rss) : null;
    }
    rows.push({ kind: 'performance-real', name, dataset: metadata.dataset, scenario: metadata.scenario, revision: metadata.code,
      centralRows: Object.values(manifest.tables.central ?? {}).reduce((n, x) => n + x.rows, 0),
      orchestratorRows: Object.values(manifest.tables.orchestrator ?? {}).reduce((n, x) => n + x.rows, 0),
      finishedAt: metadata.finishedAt ?? null, durationMs: metadata.durationMs ?? null, targetRate: metadata.configuration?.rate ?? null,
      effectiveIterationsPerSecond: stat('iterations', 'rate'), requests: stat('http_reqs', 'count'),
      requestsPerSecond: stat('http_reqs', 'rate'), drops: stat('dropped_iterations', 'count'),
      p50: stat('http_req_duration', 'p(50)'), p95: stat('http_req_duration', 'p(95)'), p99: stat('http_req_duration', 'p(99)'),
      unexpectedRate: stat('simulation_unexpected', 'rate'), postIntegrity: evidence?.integrity ?? null,
      centralPeakResidentBytes: peak.central, orchestratorPeakResidentBytes: peak.orchestrator,
      postgresPeakResidentBytes: peak.postgres, k6PeakResidentBytes: peak.k6 });
  }
  const root = 'reports/phase4-' + safe + '-comparison';
  const keys = Object.keys(rows[0]!);
  const csv = [keys.join(','), ...rows.map(row => Object.values(row).map(value =>
    '"' + (value === null ? 'unavailable' : String(value)).replaceAll('"', '""') + '"').join(','))].join('\n') + '\n';
  await writeFile(root + '.json', JSON.stringify(rows, null, 2) + '\n', { flag: 'wx' });
  await writeFile(root + '.csv', csv, { flag: 'wx' });
  return rows;
}
if (process.argv[2]) compareBaseline(process.argv[2]).then(rows => console.log(JSON.stringify(rows, null, 2)))
  .catch(() => { console.error('No se pudo comparar la ejecución'); process.exitCode = 1; });
