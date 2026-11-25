import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { formatReports, type RunMetadata } from '../reports/format.js';

export async function partialRun(source: string, metadata: RunMetadata) {
  const values: Record<string, { values: Record<string, number> }> = {};
  const runId = /^reports[\\/](phase[567]-[a-z0-9-]+)-timeline\.jsonl$/.exec(source)?.[1];
  if (!runId) throw new Error('Transmisión parcial ajena a la ejecución');
  const counters = ['iterations', 'http_reqs', 'dropped_iterations', 'simulation_operations'];
  const latency: number[] = [];
  let observedErrors = 0, errorSamples = 0;
  try {
    const input = createReadStream(source);
    try {
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const n = item.data?.value;
        if (item.type !== 'Point' || typeof n !== 'number' || !Number.isFinite(n)) continue;
        if (counters.includes(item.metric)) {
          const metric = values[item.metric] ??= { values: { count: 0 } };
          metric.values.count = (metric.values.count ?? 0) + n;
        } else if (item.metric === 'http_req_duration') latency.push(n);
        else if (item.metric === 'simulation_unexpected') { observedErrors += n; errorSamples++; }
      }
    } finally { input.destroy(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (errorSamples) values.simulation_unexpected = { values: { rate: observedErrors / errorSamples, passes: observedErrors, fails: errorSamples - observedErrors } };
  if (latency.length) {
    latency.sort((a, b) => a - b);
    values.http_req_duration = { values: { max: latency[latency.length - 1]!, ...Object.fromEntries([50, 95, 99]
      .map(p => ['p(' + p + ')', latency[Math.ceil(p / 100 * latency.length) - 1]!])) } };
  }
  const { json, csv } = formatReports(metadata, values);
  const report = 'reports/k6-' + runId;
  try {
    await writeFile(report + '.json', json, { flag: 'wx' });
    await writeFile(report + '.csv', csv, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
