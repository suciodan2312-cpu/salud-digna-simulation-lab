import { access, open, unlink, writeFile } from 'node:fs/promises';
import { CentralApi } from '../adapters/central-api/index.js';
import { Orchestrator } from '../adapters/orchestrator/index.js';
import { HttpTransport, type Request } from '../adapters/transport/index.js';
import type { Decoder } from '../contracts/index.js';
import { readConfig } from '../config/index.js';
import { institutionalRecovery } from '../scenarios/index.js';
import { runId, verifyBindings } from './control.js';
import { localPids, databases, centralOrigin, orchestratorOrigin } from './monitor.js';
import { localTarget, targets } from './targets.js';

async function main() {
  const id = runId(process.argv[2]);
  const cfg = readConfig();
  if (localTarget !== targets['integration-5m'] || process.env.SIM_COHORT_APPROVAL !== 'institucional' ||
      cfg.central !== centralOrigin || cfg.orchestrator !== orchestratorOrigin || cfg.environment !== 'local') throw Error('Destino');
  await verifyBindings(await localPids());
  await databases();
  const lock = await open('reports/phase5-execution.lock','wx');
  const start = Date.now();
  let http = 0;
  const wrap = (url: string) => {
    const transport = new HttpTransport(url,{...cfg, allowWrites:true,retries:0,timeoutMs:3000},()=>{http++;});
    return { async send<T>(r: Request, decode: Decoder<T>) {
      if (Date.now()-start >= 120000 || await access('reports/phase6-'+id+'.stop').then(()=>true,()=>false)) throw Error('Detenido');
      return transport.send(r,decode);
    }};
  };
  const env = (key: string) => { const v=process.env[key]; if(!v) throw Error('Configuración incompleta'); return v; };
  try {
    const api = new CentralApi(wrap(centralOrigin),false);
    const orch = new Orchestrator(wrap(orchestratorOrigin),['web','whatsapp'],false);
    const email = env('SIM_PATIENT_EMAIL'); if(!email.endsWith('@example.test')) throw Error('Cuenta');
    const patient = await api.login(email,env('SIM_PATIENT_PASSWORD'),'PATIENT');
    const result = await institutionalRecovery(api,orch,patient,
      { channel:'web',expectedCode:'integration-web',key:env('INSTITUTION_WEB_API') },
      { channel:'whatsapp',expectedCode:'integration-whatsapp',key:env('INSTITUTION_WHATSAPP_API') },
      env('INSTITUTION_WEB_SECRET'),env('INSTITUTION_WHATSAPP_SECRET'));
    const report = {kind:'functional-real',preset:'institucional',lab:'integration-5m',dataset:localTarget.dataset,state:'completed',
      startedAt:new Date(start).toISOString(),elapsedMs:Date.now()-start,activePatients:1,peakConcurrentActors:1,
      profiles:{omnicanal:1},http:http-1,loginHttp:1,historyRowsRead:result.historyEntries,handoffs:1,assisted:0,...result};
    await writeFile('reports/cohort-'+id+'.json',JSON.stringify(report,null,2),{flag:'wx'});
    console.log(JSON.stringify(report));
  } finally {await lock.close();await unlink('reports/phase5-execution.lock');}
}
main().catch(()=>{console.error('Recuperación institucional fallida o detenida');process.exitCode=1;});
