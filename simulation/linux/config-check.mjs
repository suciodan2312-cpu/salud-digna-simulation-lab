import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { readLabUrl } from '../dist/local/monitor.js';
import { localTarget, targets } from '../dist/local/targets.js';

const config = async name => parseEnv(await readFile('/etc/sd-lab/' + name + '.env', 'utf8'));
try {
  assert.equal(localTarget, targets['integration-5m']);
  const sim = await config('runner/simulation');
  const api = await config('api');
  const orch = await config('orchestrator');
  for (const [service, backend, owner] of [
    ['central', api, 'sim_central_app'], ['orchestrator', orch, 'salud_digna_orchestrator_app']
  ]) {
    const uri = new URL(readLabUrl(service, sim));
    assert(uri.username === owner && backend.DATABASE_URL === uri.href);
  }
  assert(api.API_HOST === '127.0.0.1' && api.API_PORT === '13104' && api.NODE_ENV === 'development');
  assert(['WHATSAPP_ENABLED', 'OPENAI_ENABLED', 'CONVERSATION_SIMULATOR_ENABLED',
    'IDENTITY_SIMULATOR_ENABLED', 'TRUST_LOCAL_PROXY'].every(key => api[key] === 'false'));
  assert(orch.ORCHESTRATOR_DB_HOST === '127.0.0.1' && orch.ORCHESTRATOR_DB_PORT === '55436' && orch.ORCHESTRATOR_PORT === '13304');
  assert(sim.SIM_CENTRAL_URL === 'http://127.0.0.1:13104' && sim.SIM_ORCHESTRATOR_URL === 'http://127.0.0.1:13304');
  assert(sim.SIM_DATASET_ID === localTarget.dataset);
} catch {
  console.error('Configuración incompatible con el laboratorio sintético integration-5m.');
  process.exitCode = 1;
}
