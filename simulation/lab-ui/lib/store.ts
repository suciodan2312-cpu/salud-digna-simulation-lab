import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fiveMillion, large, legacy, million, reportFile, runName } from './policy';
export const engine = resolve(/*turbopackIgnore: true*/ process.cwd(), '..');
const reports = resolve(engine, 'reports');
const dataPath = (id: string, file: string) => resolve(/*turbopackIgnore: true*/ reports, 'datasets', id, file);
const json = async (name: string) => {
  try { return JSON.parse((await readFile(resolve(/*turbopackIgnore: true*/ reports, name), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { return null; }
};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const ports = process.platform === 'linux' ? [{ id: fiveMillion, api: 13104, orch: 13304 }] : [{ id: legacy, api: 13100, orch: 13300 }, { id: large, api: 13101, orch: 13301 }, { id: million, api: 13102, orch: 13302 }, { id: fiveMillion, api: 13103, orch: 13303 }];
export async function datasets() {
  return Promise.all(ports.map(async target => {
    const manifest = await json('datasets/' + target.id + '/manifest.json');
    const journal = await readFile(dataPath(target.id, 'copy-journal.jsonl'), 'utf8').catch(() => '');
    const commits = new Set(journal.split(/\r?\n/).flatMap(line => {
      try { const row = JSON.parse(line); return row.dataset === target.id && row.state === 'committed' ? [row.service] : []; }
      catch { return []; }
    }));
    const count = (key: string) => Object.values((manifest?.tables?.[key] ?? {}) as Record<string, { rows: number }>)
      .reduce((total, entry) => total + entry.rows, 0);
    return { id: target.id, generated: number(manifest?.totalRows), central: count('central'), orchestrator: count('orchestrator'),
      loaded: commits.has('central') && commits.has('orchestrator') ? number(manifest?.totalRows) : null,
      seed: number(manifest?.seed), bytes: number(manifest?.totalBytes), audit: manifest?.schemaSha ?? null };
  }));
}
const check = async (port: number, path = '/api/v1/health') =>
  fetch('http://127.0.0.1:' + port + path, { redirect: 'error', signal: AbortSignal.timeout(800), cache: 'no-store' })
    .then(res => res.ok, () => false);
export async function integrationHealthy() {
  return (await Promise.all([check(13104), check(13104, '/api/v1/health/db'), check(13304)])).every(Boolean);
}
export async function services() {
  return Promise.all(ports.map(async ({ id, api, orch }) => {
    const [central, orchestrator, database] = await Promise.all([check(api), check(orch), check(api, '/api/v1/health/db')]);
    return { id, central, orchestrator, database };
  }));
}
export async function artifact(name: string) {
  if (!reportFile(name)) return null;
  const file = resolve(/*turbopackIgnore: true*/ reports, name);
  const size = await stat(file).then(value => value.size, () => 0);
  if (!size || size > 4_000_000) return null;
  return readFile(file);
}
const opCache = new Map<string, { modified: number; entries: { name: string; requests: number; p95: number | null }[] }>();
async function operationMetrics(name: string) {
  if (!/^phase[56]-/.test(name) || !runName(name)) return [];
  const file = resolve(/*turbopackIgnore: true*/ reports, name + '-timeline.jsonl');
  const info = await stat(file).catch(() => null);
  if (!info || info.size > 8_000_000) return [];
  const cached = opCache.get(name);
  if (cached?.modified === info.mtimeMs) return cached.entries;
  const readings = new Map<string, { requests: number; delay: number[] }>();
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const tag = item?.data?.tags?.name;
    if (item?.type !== 'Point' || !['central.pending', 'central.appointments'].includes(tag) ||
        !['http_reqs', 'http_req_duration'].includes(item.metric) || number(item.data.value) === null) continue;
    const metric = readings.get(tag) ?? { requests: 0, delay: [] };
    if (item.metric === 'http_reqs') metric.requests += item.data.value;
    else metric.delay.push(item.data.value);
    readings.set(tag, metric);
  }
  const entries = [...readings].map(([name, metric]) => {
    metric.delay.sort((a, b) => a - b);
    return { name, requests: metric.requests, p95: metric.delay[Math.ceil(metric.delay.length * .95) - 1] ?? null };
  });
  opCache.set(name, { modified: info.mtimeMs, entries });
  return entries;
}
export async function runs() {
  const names = (await readdir(reports)).flatMap(name => {
    const stem = /^k6-(.+)\.json$/.exec(name)?.[1];
    const resource = /^(phase[4567]-.+)-resources\.json$/.exec(name)?.[1];
    const id = stem ?? resource; return id && runName(id) ? [id] : [];
  });
  const summaries = await Promise.all([...new Set(names)].map(async name => {
    const raw = await json('k6-' + name + '.json');

    const resource = await json(name + '-resources.json');
    const meta = raw?.metadata ?? (resource ? { scenario: 'habitual', dataset: resource.dataset, finishedAt: resource.finishedAt } : null);
    if (!meta) return null;
    const measure = (metric: string, key: string) => number(raw?.metrics?.[metric]?.[key]);
    const html = reportFile(name + '.html') && await stat(resolve(reports, name + '.html')).then(() => true, () => false);
    const taggedReads = ['central.pending', 'central.appointments'].flatMap(tag => {
      const requests = measure('http_reqs{name:' + tag + '}', 'count');
      return requests === null ? [] : [{ name: tag, requests, p95: measure('http_req_duration{name:' + tag + '}', 'p(95)') }];
    });
    return { name, scenario: String(meta.scenario), date: meta.finishedAt ?? null, dataset: meta.dataset,
      rate: number(meta.configuration?.rate), duration: number(meta.durationMs),
      identities: number(meta.authenticatedIdentities ?? resource?.authenticatedIdentities), hasSummary: Boolean(raw?.metadata), integrity: resource?.integrity ?? null, state: resource?.state ?? 'recorded', vus: number(meta.configuration?.maxVUs),
      requests: measure('http_reqs', 'count'), rps: measure('http_reqs', 'rate'), ips: measure('iterations', 'rate'),
      iterations: measure('iterations', 'count'), drops: measure('dropped_iterations', 'count'), error: measure('simulation_unexpected', 'rate'),
      p50: measure('http_req_duration', 'p(50)'), p95: measure('http_req_duration', 'p(95)'), p99: measure('http_req_duration', 'p(99)'),
      maxLatency: measure('http_req_duration', 'max'), observedVUs: measure('vus', 'max'),
      html, operations: taggedReads.length ? taggedReads : await operationMetrics(name), resources: Array.isArray(resource?.samples) ? resource.samples.map((sample: any) => ({
        at: sample.system?.observedAt ?? null, services: Object.fromEntries(['central', 'orchestrator', 'postgres', 'k6'].map(service => [
          service, { resident: number(sample.system?.[service]?.residentBytes), cpu: number(sample.system?.[service]?.cpuSeconds) },
        ])), connections: { central: number(sample.database?.central?.connections), orchestrator: number(sample.database?.orchestrator?.connections) },
      })) : [] };
  }));
  return summaries.filter(row => row !== null).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}
export async function patients() {
  const sources = await Promise.all([json('phase4-frustration-01.json'), json('phase5-frustration-roles-01.json')]);
  return sources.flatMap((raw, index) => {
    if (!raw?.outcome || raw.profile !== 'frustrado') return [];
    const out = raw.outcome;
    return [{ id: 'frustracion-' + (index + 1), label: index === 0 ? 'Solicitud de asistencia' : 'Atención asistida',
      scale: number(out.scale), initial: number(out.initial), final: number(out.final), channel: out.channel,
      assistance: out.assistance === true, assisted: out.assisted === true, resumed: out.resumed === true, abandoned: out.abandoned === true,
      events: Array.isArray(out.trace) ? out.trace.map((event: any) => ({ event: event.event, origin: event.origin,
        decision: event.decision, score: number(event.frustration) })) : [] }];
  });
}

export async function behaviorRuns() {
  const files = (await readdir(reports)).filter(name => /^phase6-behavior-lab-[a-f0-9-]{12}\.json$/.test(name));
  return (await Promise.all(files.map(async name => {
    const row = await json(name);
    if (!row || !['completed', 'failed', 'cancelled'].includes(row.state)) return null;
    const profile = row.result?.profile ?? null;
    const outcome = row.result?.outcome;
    return { name: name.slice(0, -5), state: row.state, date: row.finishedAt, configured: row.configured, observed: row.observed,
      profile, channel: row.result?.channel ?? null, outcome: outcome ? {
        assisted: outcome.assisted === true, assistance: outcome.assistance === true,
        resumed: outcome.resumed === true, abandoned: outcome.abandoned === true, resolved: outcome.resolvedMs != null,
        confirmed: outcome.confirmed === true, handoffs: number(outcome.handoffs), initial: number(outcome.initial), final: number(outcome.final),
        trace: Array.isArray(outcome.trace) ? outcome.trace.map((event: any) => ({
          event: event.event, origin: event.origin, score: number(event.frustration), decision: event.decision,
        })) : [],
      } : null };
  }))).filter(row => row !== null).sort((a,b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

export async function liveRead(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) return null;
  const name = 'phase6-' + id;
  const file = resolve(/*turbopackIgnore: true*/ reports, name + '-timeline.jsonl');
  const info = await stat(file).catch(() => null);
  if (!info?.size || info.size > 18_000_000) return null;
  const source = await readFile(file, 'utf8').catch(() => '');
  let first = Infinity, last = 0, requests = 0, iterations = 0, vus: number | null = null, errors = 0;
  const latency: number[] = [];
  for (const line of source.split('\n')) {
    let point;
    try { point = JSON.parse(line); } catch { continue; }
    const value = number(point?.data?.value);
    if (point?.type !== 'Point' || value === null) continue;
    if (point.metric === 'vus') vus = value;
    if (point.metric === 'iterations') iterations += value;
    if (point.metric === 'simulation_unexpected') errors += value;
    if (point.metric === 'http_req_duration') latency.push(value);
    if (point.metric !== 'http_reqs') continue;
    const stamp = Date.parse(point.data.time);
    if (!Number.isFinite(stamp)) continue;
    requests += value;
    first = Math.min(first, stamp); last = Math.max(last, stamp);
  }
  if (!requests) return null;
  latency.sort((a,b) => a-b);
  return { requests, iterations, rps: last > first ? (requests - 1) * 1000 / (last - first) : null, vus, errors,
    p95: latency[Math.ceil(latency.length * .95) - 1] ?? null };
}
export async function latestCohort() {
  const names = (await readdir(reports)).filter(n => /^cohort-[a-z0-9][a-z0-9-]{0,47}\.json$/.test(n));
  const rows = await Promise.all(names.map(name => json(name)));
  const r = rows.filter(r => r?.kind === 'functional-real' && ['completed','failed','cancelled'].includes(r.state))
    .sort((a,b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  if (!r) return null;
  return { preset: r.preset, state: r.state, patients: number(r.activePatients), http: number(r.http),
    profiles: Object.fromEntries(['frecuente','citas','frustrado','omnicanal'].filter(k => number(r.profiles?.[k]) !== null).map(k => [k, r.profiles[k]])),
    concurrency: number(r.peakConcurrentActors), durationMs: number(r.elapsedMs),
    reads: number(r.counts?.['central.appointments']), histories: number(r.counts?.['central.history']), resumed: number(r.counts?.['central.resume']),
    history: number(r.historyRowsRead), handoffs: number(r.handoffs), assisted: number(r.assisted) };
}
export async function monitoredRun() {
  const entries = (await readdir(reports)).flatMap(file => {
    const id = /^phase6-([a-z0-9][a-z0-9-]{0,47})-resources\.json$/.exec(file)?.[1];
    return id ? [{ id, file }] : [];
  });
  for (const { id, file } of entries) {
    const report = await json(file);
    const age = Date.now() - Date.parse(report?.startedAt ?? '');
    if (report?.state === 'running' && age >= 0 && age < 645_000) return liveRead(id);
  }
  return null;
}