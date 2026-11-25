import type { Env } from '../load/plan.js';

const metrics = [
  'http_reqs', 'iterations', 'iteration_duration', 'dropped_iterations', 'http_req_duration', 'vus', 'vus_max',
  'http_reqs{name:central.pending}', 'http_reqs{name:central.appointments}',
  'http_req_duration{name:central.pending}', 'http_req_duration{name:central.appointments}',
  'simulation_unexpected', 'simulation_expected_409', 'simulation_expected_429',
  'simulation_operations', 'simulation_contexts', 'simulation_handoffs', 'simulation_duplicates',
  'simulation_appointments', 'simulation_abandoned', 'simulation_resumed', 'simulation_assistance',
  'simulation_frustration_initial', 'simulation_frustration_final', 'simulation_resolution_ms',
] as const;
export type RunMetadata = {
  scenario: string; seed: number; code: string; dataset: string | null; environment: 'local' | 'test';
  authenticatedIdentities?: number; finishedAt?: string; durationMs?: number | null;
  configuration?: { executor: string; timeoutMs: number; preAllocatedVUs: number; maxVUs: number; rate: number | null };
};
export function reportMetadata(scenario: string, seed: number, env: Env): RunMetadata {
  const code = env.SIM_CODE_REVISION ?? 'ff989cc+simulation-phase4';
  const dataset = env.SIM_DATASET_ID;
  if (!/^[a-f0-9]{7,40}(?:\+simulation-phase[234567])?$/.test(code) ||
    (dataset !== undefined && !/^[a-f0-9]{24}$/.test(dataset))) throw new Error('Identidad del reporte inválida');
  return { scenario, seed, code, dataset: dataset ?? null, environment: env.SIM_ENV === 'test' ? 'test' : 'local' };
}

export function formatReports(metadata: RunMetadata, input: Record<string, { values?: Record<string, unknown> }>) {
  const selected = Object.fromEntries(metrics.map(metric => {
    const values = input[metric]?.values;
    if (!values) return [metric, null] as const;
    const clean = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
      /^(?:avg|min|max|med|count|rate|value|p\((?:50|95|99)\)|passes|fails)$/.test(key) &&
      typeof value === 'number' && Number.isFinite(value)));
    return [metric, Object.keys(clean).length ? clean : null] as const;
  }));
  const rows = ['scenario,seed,code,dataset,environment,finishedAt,durationMs,executor,timeoutMs,preAllocatedVUs,maxVUs,rate,metric,statistic,value'];
  const prefix = [metadata.scenario, metadata.seed, metadata.code, metadata.dataset ?? '', metadata.environment,
    metadata.finishedAt ?? '', metadata.durationMs ?? '', metadata.configuration?.executor ?? '',
    metadata.configuration?.timeoutMs ?? '', metadata.configuration?.preAllocatedVUs ?? '',
    metadata.configuration?.maxVUs ?? '', metadata.configuration?.rate ?? ''];
  const add = (values: unknown[]) => rows.push([...prefix, ...values].map(item =>
    '"' + String(item).replaceAll('"', '""') + '"').join(','));
  for (const [metric, values] of Object.entries(selected)) {
    if (!values) add([metric, 'unavailable', '']);
    else for (const [statistic, value] of Object.entries(values)) add([metric, statistic, value]);
  }
  return { json: JSON.stringify({ metadata, metrics: selected }, null, 2) + '\n', csv: rows.join('\n') + '\n' };
}
