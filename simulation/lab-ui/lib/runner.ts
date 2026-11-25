import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cohorts, type CohortPlan } from '../../engine/cohort-plan';
import { approvalKey, fiveMillion, large, million, type Plan } from './policy';
import { datasets, engine, integrationHealthy, services } from './store';

type Job = { id: string; state: 'preparing' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled';
  plan: Plan | CohortPlan; startedAt: number; finishedAt: number | null };
const holder = globalThis as typeof globalThis & { simulationLabJob?: Job };
export function job() { return holder.simulationLabJob ?? null; }
export const approvedPlans = () => (process.env.SIM_LAB_ALLOWED_PLANS ?? '').split(',')
  .filter(value => process.platform !== 'linux' || value === 'cohort:institucional')
  .filter(value => /^(?:cohort:(?:cotidiana|demanda|atencion|institucional)|behavior:\d+:1|(?:[15]m:)?\d+:\d+:\d+)$/.test(value));
export async function start(plan: Plan | CohortPlan) {
  if (!approvedPlans().includes(plan.scenario === 'cohort' ? 'cohort:' + plan.preset : approvalKey(plan))) throw new Error('El operador debe autorizar este plan exacto.');
  const existing = job();
  if (existing && ['preparing', 'running', 'stopping'].includes(existing.state)) throw new Error('Ya hay una ejecución activa.');
  const cohort = plan.scenario === 'cohort';
  const behavior = plan.scenario === 'behavior';
  const target = cohort ? cohorts[plan.preset].lab : behavior ? 'baseline' : plan.dataset === fiveMillion ? 'corpus-5m' : plan.dataset === million ? 'corpus-1m' : 'corpus-100k';
  const institutional = target === 'integration-5m';
  const privateLab = institutional ? 'reports/local-lab-bff1f58-5m-1' : 'reports/local-lab-ff989cc-' + (target === 'baseline' ? '4' : target === 'corpus-5m' ? '5m-1' : target === 'corpus-1m' ? '1m-1' : '100k-1');
  const current: Job = { id: 'lab-' + randomUUID().slice(0, 12), state: 'preparing', plan, startedAt: Date.now(), finishedAt: null };
  holder.simulationLabJob = current;
  try {
    const [corpora, checks] = await Promise.all([datasets(), services()]);
    const corpus = corpora.find(row => row.id === (cohort ? target === 'baseline' ? '3ec1448fee9783a2150ccefc' : fiveMillion : plan.dataset));
    const expected = target === 'baseline' ? 1200 : target === 'corpus-100k' ? 100000 : target === 'corpus-1m' ? 1000000 : 5000000;
    const healthy = institutional ? await integrationHealthy() : checks.some(row => row.id === corpus?.id && row.central && row.orchestrator && row.database);
    if (corpus?.loaded !== expected || !healthy) {
      throw new Error('El laboratorio seleccionado debe estar activo y su COPY verificado.');
    }
    const configDir = process.platform === 'linux' ? '/etc/sd-lab/runner' : join(engine, privateLab);
    await access(join(configDir, 'actors.env'));
    const files = ['simulation.env', 'actors.env'];
    if ((cohort && plan.preset === 'atencion') || (behavior && plan.mix.omnicanal > 0)) {
      await access(join(engine, privateLab, 'channels.env'));
      files.push('channels.env');
    }
    if (institutional) files.push('institution.env');
    const args = files.map(file => '--env-file=' + join(/*turbopackIgnore: true*/ configDir, file));
    args.push(...(institutional ? ['dist/local/institutional.js', current.id] : cohort ? ['dist/local/cohort-run.js', current.id, plan.preset, String(plan.patients), String(plan.seconds)] : behavior ? ['dist/local/behavior-run.js', current.id] : ['dist/local/baseline.js', 'run', current.id]));
    const child = spawn(process.execPath, args, {
      cwd: engine, windowsHide: true, stdio: 'ignore', env: {
        NODE_ENV: 'production', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, LOCALAPPDATA: process.env.LOCALAPPDATA,
        TEMP: process.env.TEMP, TMP: process.env.TMP, SIM_LOCAL_LAB: target, SIM_PHASE6: 'true',
        ...(cohort ? { SIM_COHORT_APPROVAL: plan.preset } : {
        SIM_STAGE_RATE: String(plan.rate), SIM_STAGE_SECONDS: String(plan.seconds), SIM_STAGE_VUS: String(plan.vus),
        SIM_STAGE_SEED: String(plan.seed), SIM_STAGE_CITAS: String(plan.mix.citas),
        SIM_BASELINE_APPROVAL: [plan.rate, plan.seconds, plan.vus].join(':'),
        ...(behavior && { SIM_BEHAVIOR_APPROVAL: 'one-local-profile',
          SIM_BEHAVIOR_CONFIG: JSON.stringify({ mix: plan.mix, seed: plan.seed, initial: plan.initial, waitMs: plan.waitMs, seconds: plan.seconds }) }), }),
      },
    });
    current.state = 'running';
    child.once('error', () => { current.state = 'failed'; current.finishedAt = Date.now(); });
    child.once('close', code => {
      current.state = current.state === 'stopping' ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      current.finishedAt = Date.now();
    });
    return current;
  } catch (error) {
    current.state = 'failed';
    current.finishedAt = Date.now();
    throw error;
  }
}
export async function stop(id: string) {
  const current = job();
  if (!current || current.id !== id || current.state !== 'running') throw new Error('La ejecución no está activa.');
  current.state = 'stopping';
  try {
    await writeFile(join(engine, 'reports', 'phase6-' + current.id + '.stop'), '', { flag: 'wx' });
  } catch (error) {
    current.state = 'running';
    throw error;
  }
  return current;
}
