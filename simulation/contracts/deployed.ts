import { readFile } from 'node:fs/promises';
import { serviceSource } from '../config/service-source.js';
import { object } from './index.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export async function compareCentralContract(path: string) {
  const read = async (file: string | URL) => object(JSON.parse(await readFile(file, 'utf8')) as unknown);
  const baseline = await read(serviceSource('docs/openapi.json'));
  const candidate = await read(path);
  const sections = ['paths', 'components', 'security'] as const;
  const changed = sections.filter(key => JSON.stringify(canonical(baseline[key])) !== JSON.stringify(canonical(candidate[key])));
  return { scope: 'central-openapi-offline', compatibleSnapshot: changed.length === 0, changed,
    verifiedDeployment: false };
}
