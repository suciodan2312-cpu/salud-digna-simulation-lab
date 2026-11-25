import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linuxBindings } from './linux-bindings.js';
import { localTarget } from './targets.js';

export function runId(raw: string | undefined) {
  if (!raw || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(raw)) throw new Error('Identificador de ejecución inválido');
  return raw;
}
export async function verifyBindings(pids: { central: number; orchestrator: number; postgres: number }) {
  if (process.platform === 'linux') {
    const actual = await linuxBindings();
    if (actual.central !== pids.central || actual.orchestrator !== pids.orchestrator || actual.postgres !== pids.postgres) {
      throw new Error('Los procesos del laboratorio cambiaron');
    }
    return;
  }
  const program = process.env.SystemRoot + '\\System32\\netstat.exe';
  const { stdout } = await promisify(execFile)(program, ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 3000 });
  for (const [port, pid] of [[localTarget.central, pids.central], [localTarget.orchestrator, pids.orchestrator], [localTarget.database, pids.postgres]]) {
    if (!stdout.split(/\r?\n/).some(line => {
      const columns = line.trim().split(/\s+/);
      return columns[1] === '127.0.0.1:' + port && columns[2] === '0.0.0.0:0' && Number(columns.at(-1)) === pid;
    })) throw new Error('El listener no corresponde al laboratorio');
  }
}

export type ExecutionState = 'planned' | 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled';
export type ExecutionEvent = { type: 'state' | 'metric' | 'behavior'; at: string; name: string; value?: number };
export type ExecutionSummary = {
  id: string; dataset: string; scenario: 'read-baseline'; state: ExecutionState; progress: number | null;
  startedAt: string | null; finishedAt: string | null; events: ExecutionEvent[];
};
export interface SimulationControl {
  plan(input: { scenario: 'read-baseline'; dataset: string }): Promise<ExecutionSummary>;
  start(id: string): Promise<ExecutionSummary>;
  stop(id: string): Promise<ExecutionSummary>;
  list(): Promise<ExecutionSummary[]>;
  report(id: string): Promise<unknown>;
}
// The CLI runner is the only executor in phase 4. A future UI can implement this interface
// around the same fixed scenario, run IDs and process ownership. No shell, binary or URL input.
