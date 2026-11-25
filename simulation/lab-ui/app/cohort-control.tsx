'use client';
import { useState } from 'react';
import { cohorts, type Cohort } from '../../engine/cohort-plan';
export type CohortResult = { profiles: Record<string, number>; concurrency: number | null; durationMs: number | null; reads: number | null; histories: number | null; resumed: number | null; preset: string; state: string; patients: number; http: number; history: number; handoffs: number; assisted: number };
export function CohortControl({ busy, allowed, latest }: { busy: boolean; allowed: string[]; latest?: CohortResult }) {
  const [preset, choose] = useState<Cohort>('cotidiana');
  const [patients, size] = useState(3), [seconds, duration] = useState(120);
  const [confirm, consent] = useState(false), [sending, pending] = useState(false), [notice, message] = useState('');
  const spec = cohorts[preset];
  async function start() {
    pending(true);
    try {
      const res = await fetch('/api/lab', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', confirmed: confirm, plan: { scenario: 'cohort', preset, patients, seconds } }) });
      if (!res.ok) throw Error();
      consent(false); message('Grupo iniciado. Puedes detenerlo en Ejecución y progreso.');
    } catch { message('Inicio rechazado. Revisa el laboratorio y el plan autorizado.'); }
    finally { pending(false); }
  }
  return <article className="panel"><h2>Pacientes concurrentes</h2><div className="fields">
    <label>Operación<select value={preset} onChange={e=>{const v=e.target.value as Cohort;choose(v);size(Math.min(patients,cohorts[v].limit));if(v==='institucional')duration(120);consent(false);}}>
      {Object.entries(cohorts).map(([k,v])=><option key={k} value={k}>{v.title}</option>)}</select></label>
    <label>Máximo de pacientes<input type="number" min={1} max={spec.limit} value={patients} onChange={e=>{size(+e.target.value);consent(false);}}/></label>
    <label>Duración<select disabled={preset==='institucional'} value={seconds} onChange={e=>{duration(+e.target.value);consent(false);}}><option value={120}>2 minutos</option><option value={8}>8 segundos · comprobación</option></select></label>
    </div><p>{preset==='institucional'?'integration-5m · un recorrido de identidad':spec.lab==='baseline'?'Laboratorio original · canales y personal':'Laboratorio 5M'} {preset==='institucional'?'· una ejecución': '· hasta '+spec.httpRate+' peticiones HTTP/s.'} Se utilizan las cuentas preparadas disponibles.</p>
    <label className="checkbox"><input type="checkbox" checked={confirm} onChange={e=>consent(e.target.checked)}/> Confirmo la simulación local de este grupo.</label>
    <button className="primary" disabled={!confirm || sending || busy || !allowed.includes('cohort:'+preset) || !Number.isInteger(patients) || patients<1 || patients>spec.limit} onClick={()=>void start()}>Iniciar grupo</button>
    {notice && <p role="status">{notice}</p>}
    {latest && <div className="row"><span>Último grupo · {latest.preset} · {latest.state}</span><b>{latest.patients} pacientes activos · {latest.http} peticiones de operación · {latest.history} eventos leídos · {latest.handoffs} traspasos · {latest.assisted} atenciones asistidas</b></div>}
    {latest && <><div className="row"><span>Perfiles observados</span><b>{Object.entries(latest.profiles).map(([name,n])=>name+' · '+n).join(', ') || 'Sin mediciones'}</b></div>
      <div className="row"><span>Actores concurrentes · HTTP/s de operación</span><b>{latest.concurrency ?? 'Sin mediciones'} · {latest.durationMs ? (latest.http*1000/latest.durationMs).toFixed(2) : 'Sin mediciones'}</b></div>
      <div className="row"><span>Consultas de citas / historial / reanudaciones</span><b>{latest.reads ?? 'Sin mediciones'} / {latest.histories ?? 'Sin mediciones'} / {latest.resumed ?? 'Sin mediciones'}</b></div></>}
  </article>;
}
