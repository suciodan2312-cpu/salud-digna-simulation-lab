'use client';

import { CohortControl, type CohortResult } from './cohort-control';
import { useEffect, useState } from 'react';
import { Activity, BarChart3, Check, CircleAlert, Clock3, Database, Download, FlaskConical, Gauge, History,
  LayoutDashboard, Play, Server, SlidersHorizontal, Square, Users, Zap } from 'lucide-react';
import { approvalKey, behaviorMix, fiveMillion, keys, large, legacy, million, readMix, type Mix, type Plan } from '../lib/policy';

type Dataset = { id: string; generated: number | null; loaded: number | null; central: number; orchestrator: number; seed: number | null };
type Group = { resident: number | null; cpu: number | null };
type Sample = { at: string | null; services: Record<string, Group>; connections: { central: number | null; orchestrator: number | null } };
type Run = { name: string; dataset: string; scenario: string; date: string | null; rate: number | null;
  duration: number | null; state: string; integrity: string | null; requests: number | null; rps: number | null; ips: number | null;
  maxLatency: number | null; observedVUs: number | null; p50: number | null; p95: number | null; p99: number | null; drops: number | null; error: number | null;
  iterations: number | null; vus: number | null; identities: number | null; hasSummary: boolean; html: boolean; resources: Sample[]; operations: { name: string; requests: number; p95: number | null }[] };
type Patient = { id: string; label: string; initial: number | null; final: number | null; channel: string;
  assistance: boolean; assisted: boolean; resumed: boolean; abandoned: boolean;
  events: { event: string; origin: string; decision: string; score: number | null }[] };
type Behavior = { name: string; state: string; date: string | null; configured: Mix; observed: Partial<Mix>; profile: string | null;
  channel: string | null; outcome: { assisted: boolean; assistance: boolean; resumed: boolean; abandoned: boolean; resolved: boolean;
    confirmed: boolean; handoffs: number | null; initial: number | null; final: number | null;
    trace: { event: string; origin: string; score: number | null; decision: string }[] } | null };
type Snapshot = { latestCohort?: CohortResult; datasets: Dataset[]; runs: Run[]; patients: Patient[];
  services: { id: string; central: boolean; orchestrator: boolean; database: boolean }[];
  behaviorHistory: Behavior[]; live: { requests: number; rps: number | null; iterations: number; p95: number | null; vus: number | null; errors: number } | null; allowed: string[]; job: { id: string; state: string; startedAt: number; plan: Plan } | null };
const menu = [
  ['resumen', 'Resumen', LayoutDashboard],
  ['control', 'Centro de control', SlidersHorizontal],
  ['pacientes', 'Pacientes virtuales', Users],
  ['rendimiento', 'Rendimiento', BarChart3],
  ['historial', 'Historial', History],
] as const;
type Tab = typeof menu[number][0];
const fmt = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? 'No disponible' : new Intl.NumberFormat('es-MX', { maximumFractionDigits: digits }).format(value);
const units = (value: number | null | undefined, suffix: string, digits = 0) => value == null ? 'No disponible' : fmt(value, digits) + ' ' + suffix;
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'No disponible';
const label: Record<string,string> = { habitual: 'Lecturas de pacientes', smoke: 'Smoke local', startingConcern: 'Inconformidad inicial',
  unresolved: 'Atención pendiente', humanResolved: 'Atención recuperada', reread: 'Relectura de contexto', delay: 'Demora observada',
  conflict: 'Conflicto de versiones', assist: 'Solicitud de asistencia', wait: 'Espera', abandon: 'Decisión de abandonar' };
const names: Record<string,string> = { central: 'API central', orchestrator: 'Orquestador', postgres: 'PostgreSQL', k6: 'Generador k6' };

function Stat({ icon: Icon, title, value, note }: { icon: typeof Activity; title: string; value: string; note: string }) {
  return <article className="stat"><div className="stat-head"><span>{title}</span><Icon size={19}/></div><strong>{value}</strong><small>{note}</small></article>;
}
function Status({ ok }: { ok: boolean }) {
  return <span className={'status ' + (ok ? 'good' : 'muted')}><i/>{ok ? 'Disponible' : 'Sin respuesta'}</span>;
}
function ExportLinks({ run }: { run: Run }) {
  if (!run.hasSummary) return <span>Sin reporte final</span>;
  const url = (file: string) => '/api/lab?report=' + encodeURIComponent(file);
  return <div className="exports"><a href={url('k6-' + run.name + '.json')}><Download size={14}/> JSON</a>
    <a href={url('k6-' + run.name + '.csv')}>CSV</a>
    {run.html && <a href={url(run.name + '.html')}>HTML</a>}</div>;
}
function MemoryChart({ samples }: { samples: Sample[] }) {
  const rows = samples.flatMap(s => {
    const v = s.services.central?.resident;
    return v == null ? [] : [{ at: s.at, value: v / 1048576 }];
  });
  if (rows.length < 2) return <div className="empty">Sin mediciones temporales en esta ejecución.</div>;
  const peak = Math.max(...rows.map(r => r.value));
  return <figure><figcaption>Memoria residente de la API central · muestras reales</figcaption>
    <div className="bars" role="img" aria-label="Serie temporal de memoria residente">
      {rows.map((row, index) => <div className="barCol" key={index} title={date(row.at) + ' · ' + fmt(row.value, 1) + ' MiB'}>
        <span>{fmt(row.value, 0)}</span><b style={{ height: (row.value / peak) * 82 + '%' }}/></div>)}
    </div><div className="axis"><span>{date(rows[0].at)}</span><span>{date(rows.at(-1)?.at)}</span></div>
  </figure>;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>('resumen');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const [patientId, setPatientId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan>({ dataset: large, scenario: 'patient-reads', rate: 5, seconds: 60, vus: 5, seed: 42, initial: 95, waitMs: 0, mix: readMix });
  const [clock, setClock] = useState(Date.now());
  const [presentation, setPresentation] = useState(false);
  const [preview, setPreview] = useState<Plan | null>(null);
  const [recordedBehavior, setRecordedBehavior] = useState('');
  const update = (patch: Partial<Plan>) => { setPlan(previous => ({ ...previous, ...patch })); setConfirm(false); setPreview(null); };
  const scenario = (value: Plan['scenario']) => update(value === 'behavior'
    ? { scenario: value, dataset: legacy, rate: 1, vus: 1, seconds: 60, mix: behaviorMix }
    : { scenario: value, dataset: large, rate: 5, vus: 5, seconds: 60, mix: readMix, waitMs: 0 });
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const res = await fetch('/api/lab', { cache: 'no-store' });
        if (!res.ok) throw new Error();
        const data: Snapshot = await res.json();
        if (active) setSnapshot(data);
      } catch { if (active) setNotice('El servicio del panel no responde.'); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { setClock(Date.now()); void refresh(); }, 3500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function command(action: 'start' | 'stop' | 'validate') {
    setBusy(true); setNotice('');
    try {
      const res = await fetch('/api/lab', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, plan, confirmed: confirm, id: snapshot?.job?.id }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      if (action === 'validate') setPreview(body.plan);
      if (action !== 'validate') setSnapshot(prev => prev && ({ ...prev, job: body }));
      setNotice(action === 'validate' ? 'El formato del plan es válido.' : action === 'stop' ? 'Detención solicitada.' : 'Ejecución local iniciada.');
      if (action === 'start') setConfirm(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Operación fallida.'); }
    finally { setBusy(false); }
  }
  const latest = snapshot?.runs.find(row => row.state === 'completed') ?? snapshot?.runs[0];
  const run = snapshot?.runs.find(row => row.name === selected) ?? latest;
  const patient = snapshot?.patients.find(row => row.id === patientId) ?? snapshot?.patients[0];
  const job = snapshot?.job;
  const draftTotal = keys.reduce((sum, key) => sum + plan.mix[key], 0);
  const availableDatasets = (snapshot?.datasets ?? []).filter(d => d.loaded != null &&
    (plan.scenario === 'behavior' ? d.id === legacy : d.id !== legacy));
  const behavior = snapshot?.behaviorHistory.find(row => row.name === recordedBehavior) ?? snapshot?.behaviorHistory[0];
  const live = job?.state === 'running' || job?.state === 'preparing' || job?.state === 'stopping';
  const offered = snapshot?.allowed.includes(approvalKey(plan));
  const loading = !snapshot && !notice;
  const ready = snapshot?.services.some(row => row.central && row.orchestrator && row.database);
  const total = (key: 'generated' | 'loaded') => snapshot?.datasets.some(d => d[key] != null)
    ? snapshot.datasets.reduce((sum, d) => sum + (d[key] ?? 0), 0) : null;

  return <div className={"shell " + (presentation ? "presentation" : "")}>
    <aside aria-label="Navegación principal">
      <a className="brand" href="#resumen" onClick={() => setTab('resumen')}><div className="mark"><Activity size={25}/></div><div><b>Salud Digna</b><span>Simulation Lab</span></div></a>
      <nav>{menu.map(([key, title, Icon]) => <button key={key} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}>
        <Icon size={19}/>{title}</button>)}</nav>
      <div className="side-footer"><FlaskConical size={19}/><div><b>Laboratorio local</b><span>HackaTec Nacional</span></div></div>
    </aside>
    <main>
      <header className="top"><div><span className="eyebrow">SALUD DIGNA SIMULATION LAB</span><h1>{menu.find(row => row[0] === tab)?.[1]}</h1></div>
        <div className="top-actions"><span className="local"><i/> Solo loopback</span><button className="secondary" onClick={()=>setPresentation(!presentation)}>{presentation ? "Cerrar presentación" : "Modo HackaTec"}</button></div></header>
      {notice && <div className="notice" role="status"><CircleAlert size={18}/>{notice}<button onClick={() => setNotice('')} aria-label="Cerrar aviso">×</button></div>}
      {loading && <div className="empty" role="status">Leyendo reportes del laboratorio…</div>}
      {presentation && <section className="panel demo"><h2>Demostración HackaTec</h2>
        <div className="row"><span>Corpus cargado · journal</span><b>{fmt(total('loaded'))} filas</b></div>
        <div className="row"><span>{snapshot?.live ? 'En vivo · lectura k6' : 'Histórico · última prueba completa'}</span><b>
          {fmt(snapshot?.live?.requests ?? latest?.requests)} peticiones · {units(snapshot?.live?.rps ?? latest?.rps,'req/s',2)} · p95 {units(snapshot?.live?.p95 ?? latest?.p95,'ms',2)}</b></div>
        <div className="row"><span>Continuidad del orquestador</span><b>Continuidad local validada en la fase 3</b></div>
        <div className="row"><span>Atención asistida · evidencia histórica</span><b>{snapshot?.patients.some(p=>p.assisted) ? 'Referencia canjeada y contexto recuperado' : 'Sin evidencia disponible'}</b></div>
      </section>}
      {tab === 'resumen' && <>
        <section className="hero"><div><span><FlaskConical size={16}/> LABORATORIO DE SIMULACIÓN</span>
          <h2>Observa el sistema<br/>bajo demanda.</h2><p>Corpus sintéticos, recorridos reales y evidencia de rendimiento en un entorno aislado.</p>
          <button onClick={() => setTab('control')}><SlidersHorizontal size={17}/> Abrir centro de control</button></div>
          <div className="hero-side"><span>ÚLTIMA EJECUCIÓN</span><strong>{latest ? (label[latest.scenario] ?? latest.scenario) : 'Sin mediciones'}</strong>
            <p><Clock3 size={16}/>{date(latest?.date)}</p><span className="hero-state"><i/>{ready ? 'Laboratorio disponible' : 'Verificando servicios'}</span></div>
        </section>
        <section className="stats" aria-label="Indicadores principales">
          <Stat icon={Database} title="Registros generados" value={fmt(total('generated'))} note="Total de manifiestos disponibles"/>
          <Stat icon={Server} title="Registros cargados" value={fmt(total('loaded'))} note="Confirmados por el journal de COPY"/>
          <Stat icon={Zap} title="Peticiones HTTP" value={fmt(latest?.requests)} note="Última ejecución medida"/>
          <Stat icon={Gauge} title="Latencia p95" value={units(latest?.p95, 'ms', 2)} note="Percentil de la última ejecución"/>
        </section>
        <section className="grid"><article className="panel"><h2>Estado de los servicios</h2>
          {snapshot?.services.map(row => <div className="serviceSet" key={row.id}><h3>{row.id === fiveMillion ? 'Laboratorio 5M' : row.id === million ? 'Laboratorio 1M' : row.id === large ? 'Laboratorio 100K' : 'Laboratorio inicial'}</h3>
            {([['API central', row.central], ['Orquestador', row.orchestrator], ['PostgreSQL', row.database]] as const).map(([name, ok]) =>
              <div className="row" key={name}><span>{name}</span><Status ok={ok}/></div>)}</div>)}
        </article><article className="panel"><h2>Detalle de la última ejecución</h2>
          <div className="row"><span>Iteraciones/s</span><b>{fmt(latest?.ips, 2)}</b></div>
          <div className="row"><span>Latencia p50 · p99</span><b>{units(latest?.p50, 'ms', 2)} · {units(latest?.p99, 'ms', 2)}</b></div>
          <div className="row"><span>Errores inesperados</span><b>{latest?.error == null ? 'No disponible' : fmt(latest.error * 100, 2) + '%'}</b></div>
          <div className="row"><span>Usuarios virtuales activos · en vivo</span><b>{fmt(snapshot?.live?.vus)}</b></div>
          {latest && <ExportLinks run={latest}/>}
        </article></section>
      </>}
      {tab === 'control' && <section className="grid">
        <article className="panel"><h2>Configurar ejecución</h2><p className="sub">Tráfico local acotado. El operador autoriza cada combinación antes de habilitar el inicio.</p>
          <div className="fields">
            <label>Escenario<select value={plan.scenario} onChange={e=>scenario(e.target.value as Plan["scenario"])}><option value="patient-reads">Lecturas de pacientes</option><option value="behavior">Comportamiento individual</option></select></label>
            <label>Dataset<select value={plan.dataset} onChange={e => update({ dataset: e.target.value })}>
              {availableDatasets.map(d => <option key={d.id} value={d.id}>{fmt(d.generated)} filas · {d.id.slice(0, 8)}</option>)}</select></label>

            <label>Duración<select value={plan.seconds} onChange={e => { update({ seconds: +e.target.value }); }}><option value={30}>30 s</option><option value={60}>60 s</option>{plan.scenario === "patient-reads" && <><option value={300}>5 min</option><option value={600}>10 min</option></>}</select></label>
            <label>Tasa objetivo<select disabled={plan.scenario === "behavior"} value={plan.rate} onChange={e => { update({ rate: +e.target.value }); }}>{(plan.scenario === "behavior" ? [1] : [5,10,25,50,100]).map(rate => <option key={rate} value={rate}>{rate} iteraciones/s</option>)}</select></label>
            <label>Máximo de VUs<select disabled={plan.scenario === "behavior"} value={plan.vus} onChange={e => { update({ vus: +e.target.value }); }}>{(plan.scenario === "behavior" ? [1] : [2,5,10,20]).map(vus => <option key={vus}>{vus}</option>)}</select></label>
            <label>Semilla<input type="number" min={0} max={4294967295} value={plan.seed} onChange={e=>update({seed:+e.target.value})}/></label>
            <label>Espera por decisión (ms)<input type="number" disabled={plan.scenario !== 'behavior'} min={0} max={5000} value={plan.waitMs} onChange={e=>update({waitMs:+e.target.value})}/></label>
            <label>Frustración inicial (0–100)<input type="number" disabled={plan.scenario !== 'behavior'} min={0} max={100} value={plan.initial} onChange={e=>update({initial:+e.target.value})}/></label>
          </div>
          <h3>Mezcla configurada · {draftTotal}%</h3>
          <div className="fields mix">{keys.map(key => <label key={key}>{key}
            <input aria-label={key + ' porcentaje'} type="number" min={0} max={100}
              disabled={plan.scenario === 'patient-reads' && key !== 'frecuente' && key !== 'citas'}
              value={plan.mix[key]} onChange={e=>update({ mix: { ...plan.mix, [key]: +e.target.value } })}/>
          </label>)}</div>
          <p className="sub">Resultados clínicos: capacidad deshabilitada. El comportamiento ejecuta un perfil por plan. El ensayo de capacidad usa solo lecturas.</p>
          {preview && <div className="notice" role="status">Plan validado · {preview.scenario} · {preview.seconds} s · semilla {preview.seed}</div>}
          <label className="checkbox"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)}/> Confirmo tráfico exclusivo en el laboratorio local.</label>
          {!offered && <p className="sub">Este plan aún no se habilitó en el servidor local.</p>}
          <div className="actions"><button className="secondary" disabled={busy} onClick={() => void command('validate')}><Check size={17}/> Validar plan</button>
            <button className="primary" disabled={busy || !offered || !confirm || live || !preview || draftTotal !== 100} onClick={() => void command('start')}><Play size={17}/> Iniciar prueba</button></div>
        </article>
        <CohortControl busy={Boolean(live)} allowed={snapshot?.allowed ?? []} latest={snapshot?.latestCohort}/>
        <article className="panel"><h2>Ejecución y progreso</h2>
          {!job ? (snapshot?.live ? <div className="notice">Runner local en vivo · {fmt(snapshot.live.requests)} peticiones · {units(snapshot.live.rps,'req/s',2)} · p95 {units(snapshot.live.p95,'ms',2)}</div> : <div className="empty">Sin ejecución iniciada desde el panel.</div>) : <>
            <div className="row"><span>Identificador</span><b>{job.id}</b></div><div className="row"><span>Estado</span><b>{({preparing:'Preparando',running:'En ejecución',stopping:'Deteniendo',completed:'Completada',failed:'Fallida',cancelled:'Cancelada'} as Record<string,string>)[job.state] ?? job.state}</b></div>
            {snapshot?.live && <><div className="row"><span>Peticiones procesadas · en vivo</span><b>{fmt(snapshot.live.requests)}</b></div>
              <div className="row"><span>Tasa HTTP · en vivo</span><b>{units(snapshot.live.rps,'req/s',2)}</b></div>
              <div className="row"><span>p95 · en vivo</span><b>{units(snapshot.live.p95,'ms',2)}</b></div></>}
            {live && <><progress max={job.plan.seconds} value={Math.min(job.plan.seconds, Math.max(0, (clock-job.startedAt)/1000))}/><p className="sub">Tiempo aproximado desde el inicio del proceso.</p></>}
            <button className="secondary" disabled={job.state !== 'running' || busy} onClick={() => void command('stop')}><Square size={15}/> Detener esta prueba</button>
          </>}
        </article>
      </section>}
      {tab === 'pacientes' && <section className="grid">
        <article className="panel"><h2>Actividad registrada</h2><p className="sub">Evidencia funcional local. Las puntuaciones de frustración son sintéticas.</p>
          {snapshot?.patients.map(row => <button key={row.id} className={'pick ' + (patient?.id === row.id ? 'selected' : '')} onClick={() => setPatientId(row.id)}>
            <Users size={20}/><span><b>{row.label}</b><small>Reproducción histórica · {row.channel}</small></span></button>)}
                    {behavior && <><label className="sectionBar">Recorrido del motor<select value={behavior.name} onChange={e=>setRecordedBehavior(e.target.value)}>
            {snapshot?.behaviorHistory.map(row=><option key={row.name}>{row.name}</option>)}</select></label>
          <div className="row"><span>Configurada</span><b>{keys.filter(k=>behavior.configured[k]>0).map(k=>k+' '+behavior.configured[k]+'%').join(' · ')}</b></div>
          <div className="row"><span>Observada · actor completado</span><b>{Object.entries(behavior.observed).map(([k,v])=>k+' '+v).join(' · ') || 'Sin mediciones'}</b></div>
          <div className="row"><span>Canal · estado</span><b>{behavior.channel ?? 'No disponible'} · {behavior.state}</b></div>
          <div className="row"><span>Traspasos verificados</span><b>{fmt(behavior.outcome?.handoffs)}</b></div>
          {behavior.outcome && <><div className="row"><span>Asistencia / resolución</span><b>{behavior.outcome.assisted ? 'Contexto recuperado' : behavior.outcome.assistance ? 'Solicitada' : 'Sin solicitud'}</b></div>
            {behavior.outcome.trace.length > 0 && <ol className="events">{behavior.outcome.trace.map((event,i)=><li key={i}>{label[event.event] ?? event.event} · {event.origin} · {fmt(event.score)}/100</li>)}</ol>}</>}
          </>}
          <div className="row"><span>Pacientes virtuales activos</span><b>Sin mediciones</b></div>
        </article><article className="panel"><h2>Recorrido individual</h2>
          {!patient ? <div className="empty">Sin reportes de comportamiento.</div> : <>
            <div className="score">{fmt(patient.initial)} <small>inicial</small><span>·</span> {fmt(patient.final)} <small>final</small></div>
            <div className="row"><span>Asistencia humana</span><b>{patient.assisted ? 'Contexto recuperado' : patient.assistance ? 'Solicitada' : 'Sin solicitud'}</b></div>
            <div className="row"><span>Reanudación / abandono</span><b>{patient.resumed ? 'Retomada' : patient.abandoned ? 'Abandonada' : 'Sin transición registrada'}</b></div>
            <ol className="events">{patient.events.map((event, i) => <li key={i}><b>{label[event.event] ?? event.event}</b>
              <span>{event.origin === 'observed' ? 'Observado' : event.origin === 'injected' ? 'Inyectado' : 'Sintético'} · {fmt(event.score)} / 100</span></li>)}</ol>
          </>}
        </article>
      </section>}
      {tab === 'rendimiento' && <><div className="sectionBar"><label>Ejecución<select value={run?.name ?? ''} onChange={e => setSelected(e.target.value)}>
        {!run && <option value="">Sin mediciones</option>}{snapshot?.runs.map(row => <option key={row.name}>{row.name}</option>)}</select></label></div>
        <section className="stats"><Stat icon={Zap} title="Peticiones/s" value={fmt(run?.rps, 2)} note="Tasa efectiva de la ejecución"/>
          <Stat icon={Gauge} title="Latencia p95" value={units(run?.p95, 'ms', 2)} note="Respuestas HTTP medidas"/>
          <Stat icon={Activity} title="Iteraciones descartadas" value={fmt(run?.drops)} note="Contador de k6"/><Stat icon={CircleAlert} title="Errores inesperados" value={run?.error == null?'No disponible':fmt(run.error*100,2)+'%'} note="Tasa de k6"/></section>
        <section className="grid"><article className="panel"><h2>Serie de recursos</h2><MemoryChart samples={run?.resources ?? []}/></article>
          <article className="panel"><h2>Recursos por servicio</h2>
            {Object.entries(names).map(([key, name]) => {
              const last = run?.resources.map(s => s.services[key]).filter(v => v?.resident != null).at(-1);
              return <div className="row" key={key}><span>{name}</span><b>{last?.resident == null ? 'No disponible' : fmt(last.resident/1048576,1)+' MiB'} · {units(last?.cpu, 's CPU', 2)}</b></div>;
            })}<div className="row"><span>Conexiones PostgreSQL · API / Orquestador</span><b>{fmt(run?.resources.at(-1)?.connections.central)} / {fmt(run?.resources.at(-1)?.connections.orchestrator)}</b></div>
          </article></section>
        <article className="panel comparison"><h2>Lecturas por operación · API central</h2>
          <div className="row"><span>Iteraciones/s · objetivo / efectivas</span><b>{fmt(run?.rate)} / {fmt(run?.ips, 2)}</b></div>
          <div className="row"><span>Iteraciones completadas · peticiones HTTP</span><b>{fmt(run?.iterations)} · {fmt(run?.requests)}</b></div>
          <div className="row"><span>Latencia HTTP · p50 / p99 / máxima</span><b>{units(run?.p50, 'ms', 2)} / {units(run?.p99, 'ms', 2)} / {units(run?.maxLatency, 'ms', 2)}</b></div>
          <div className="row"><span>VUs activos · máximo muestreado / límite</span><b>{fmt(run?.observedVUs)} / {fmt(run?.vus)}</b></div>
          {run?.operations.length ? run.operations.map(op => <div className="row" key={op.name}>
            <span>{op.name === 'central.pending' ? 'Solicitudes pendientes' : 'Próximas citas'}</span>
            <b>{fmt(op.requests)} peticiones · p95 {units(op.p95, 'ms', 2)}</b>
          </div>) : <div className="empty">Sin mediciones por operación.</div>}
        </article></>}
      {tab === 'historial' && <>
        <article className="panel"><h2>Ejecuciones reales</h2>
          {!snapshot?.runs.length ? <div className="empty">No hay ejecuciones con mediciones.</div> :
            <div className="tableWrap"><table><thead><tr><th>Ejecución</th><th>Dataset</th><th>Duración</th><th>Tasa objetivo</th><th>Identidades</th><th>p95</th><th>Estado</th><th>Reportes</th></tr></thead>
              <tbody>{snapshot.runs.map(row => <tr key={row.name}><td><button className="tableButton" onClick={() => {setSelected(row.name);setTab('rendimiento');}}>{label[row.scenario] ?? row.scenario}</button><small>{date(row.date)}</small></td>
                <td>{row.dataset?.slice(0,8) ?? 'No disponible'}</td><td>{row.duration == null ? 'No disponible' : units(row.duration/1000, 's', 2)}</td>
                <td>{fmt(row.rate)}</td><td>{fmt(row.identities)}</td><td>{units(row.p95, 'ms', 2)}</td><td>{row.state === 'completed' ? 'Completada' : row.state === 'cancelled' ? 'Cancelada · parcial' : row.state === 'threshold-stopped' ? 'Detenida por umbral' : row.state === 'failed' ? 'Fallida' : row.state === 'running' ? 'En ejecución' : 'Registrada'}</td><td><ExportLinks run={row}/></td></tr>)}</tbody></table></div>}
        </article>
        <article className="panel comparison"><h2>Comparación de mediciones</h2><p className="sub">Cada tarjeta conserva el escenario y corpus de origen.</p>
          <section className="stats">{snapshot?.runs.slice(0,4).map(row => <Stat icon={Gauge} key={row.name} title={row.name} value={units(row.p95, 'ms', 2)} note={fmt(row.requests) + ' peticiones · ' + (row.dataset?.slice(0,8) ?? 'sin dataset')}/>)}</section>
        </article></>}
    </main>
  </div>;
}
