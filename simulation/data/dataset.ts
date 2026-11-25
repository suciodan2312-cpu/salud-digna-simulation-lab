import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { corpus, corpusVersion, copyLine, datasetId, fileName, referenceDate, schemaSha,
  services, tableEntries, validateInputs, type Service } from './corpus.js';
import { integer, literal, object, string } from '../contracts/index.js';

type FileSummary = { rows: number; bytes: number; sha256: string };
type TableSummary = Record<Service, Record<string, FileSummary>>;
export type Manifest = {
  id: string; seed: number; referenceDate: string; schemaSha: typeof schemaSha; corpusVersion: number;
  totalRows: number; totalBytes: number; generationMs: number; tables: TableSummary;
  validations: string[]; errors: string[];
};
type Accumulator = { rows: number; bytes: number; hash: Hash; buffer: string; output?: FileHandle };
function accumulators() {
  return new Map(services.flatMap(service => tableEntries(service).map(([table]) =>
    [fileName(service, table), { rows: 0, bytes: 0, buffer: '', hash: createHash('sha256') } as Accumulator] as const)));
}
function accumulate(acc: Accumulator, line: string) {
  acc.rows++;
  acc.bytes += Buffer.byteLength(line);
  acc.hash.update(line);
}
function summarize(files: Map<string, Accumulator>): TableSummary {
  return Object.fromEntries(services.map(service => [service, Object.fromEntries(tableEntries(service).map(([table]) => {
    const acc = files.get(fileName(service, table))!;
    return [table, { rows: acc.rows, bytes: acc.bytes, sha256: acc.hash.digest('hex') }];
  }))])) as TableSummary;
}
async function flush(acc: Accumulator) {
  if (!acc.buffer) return;
  await acc.output!.writeFile(acc.buffer, 'utf8');
  acc.buffer = '';
}
const summaries = (tables: TableSummary) => services.flatMap(service => Object.values(tables[service]));

// A manifest is written last. Incomplete directories are rejected and left for inspection.
export async function generateDataset(parent: string, seed: number, totalRows: number, reference = referenceDate) {
  validateInputs(seed, totalRows, reference);
  const start = performance.now();
  const id = datasetId(seed, totalRows, reference);
  const directory = resolve(parent, id);
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { directory, reused: true, manifest: await validateDataset(directory, id) };
  }
  const files = accumulators();
  try {
    for (const [name, acc] of files) acc.output = await open(resolve(directory, name), 'wx');
    for (const row of corpus(seed, totalRows, reference)) {
      const acc = files.get(fileName(row.service, row.table))!;
      const line = copyLine(row.values);
      accumulate(acc, line);
      acc.buffer += line;
      if (acc.buffer.length >= 65_536) await flush(acc);
    }
    for (const acc of files.values()) await flush(acc);
  } finally {
    await Promise.all([...files.values()].map(acc => acc.output?.close()));
  }
  const tables = summarize(files);
  if (summaries(tables).reduce((sum, file) => sum + file.rows, 0) !== totalRows) throw new Error('Conteo de corpus inconsistente');
  const manifest: Manifest = { id, seed, referenceDate: reference, schemaSha, corpusVersion, totalRows, tables,
    totalBytes: summaries(tables).reduce((sum, file) => sum + file.bytes, 0), generationMs: Math.round(performance.now() - start),
    validations: ['conteo total', 'SHA-256 por tabla', 'grupo determinista con referencias locales por servicio'], errors: [] };
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { directory, reused: false, manifest };
}

export async function validateDataset(directory: string, requiredId?: string): Promise<Manifest> {
  const raw = object(JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as unknown);
  const seed = integer(raw.seed), totalRows = integer(raw.totalRows, 1), reference = string(raw.referenceDate);
  validateInputs(seed, totalRows, reference);
  literal(raw.schemaSha, schemaSha);
  const id = datasetId(seed, totalRows, reference);
  if (raw.id !== id || (requiredId && requiredId !== id) || raw.corpusVersion !== corpusVersion ||
      !Array.isArray(raw.errors) || raw.errors.length) throw new Error('Manifiesto incompatible');
  const files = accumulators();
  for (const row of corpus(seed, totalRows, reference)) accumulate(files.get(fileName(row.service, row.table))!, copyLine(row.values));
  const tables = summarize(files);
  const manifestTables = object(raw.tables);
  for (const service of services) {
    const manifestService = object(manifestTables[service]);
    for (const [table, expected] of Object.entries(tables[service])) {
      const reported = object(manifestService[table]);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(resolve(directory, fileName(service, table)))) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
      }
      if (reported.rows !== expected.rows || reported.bytes !== expected.bytes || reported.sha256 !== expected.sha256 ||
          bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error(`Dataset alterado (${service}.${table})`);
    }
  }
  const totalBytes = summaries(tables).reduce((sum, file) => sum + file.bytes, 0);
  if (raw.totalBytes !== totalBytes) throw new Error('Tamaño de corpus inconsistente');
  return { id, seed, referenceDate: reference, schemaSha, corpusVersion, totalRows, totalBytes, tables,
    generationMs: integer(raw.generationMs), validations: ['regeneración determinista', 'SHA-256, tamaño y conteos verificados'], errors: [] };
}
