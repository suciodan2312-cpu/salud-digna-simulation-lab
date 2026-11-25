import { access, open, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CentralApi, type CentralSession } from '../adapters/central-api/index.js';
import { Orchestrator } from '../adapters/orchestrator/index.js';
import { HttpTransport, type Transport, type Request } from '../adapters/transport/index.js';
import type { Decoder } from '../contracts/index.js';
import { cohortPlan, cohorts } from '../engine/cohort-plan.js';
import { runProfile } from '../engine/behavior.js';
import { seededRandom } from '../engine/index.js';
import { continuity } from '../scenarios/index.js';
import { runId } from './control.js';
import { patientPool, privateRows, verifiedLab } from './cohort-pool.js';
import { localTarget, targets } from './targets.js';

class Finished extends Error {}
type Staff = { role: 'ADVISOR' | 'ADMIN'; email: string; password: string };
async function main() {
  const id = runId(process.argv[2]);
  const plan = cohortPlan(process.argv[3], Number(process.argv[4]), Number(process.argv[5] ?? 120));
  const preset = cohorts[plan.preset];
  if (localTarget !== targets[preset.lab] || process.env.SIM_COHORT_APPROVAL !== plan.preset) throw Error('Plan no autorizado');
  const cfg = await verifiedLab();
  const lockPath = 'reports/phase5-execution.lock';
  const lock = await open(lockPath, 'wx');
  try {
    const reportPath = 'reports/cohort-' + id + '.json';
    const report = await open(reportPath, 'wx');
    await report.close();
    const people = [...(await patientPool()).values()].filter(p => p.state === 'ready' && Date.parse(p.upcomingUntil ?? '') > Date.now() + plan.seconds * 1000).slice(0, plan.patients);
    const startedAt = new Date().toISOString();
    let begin = 0, end = Infinity, last = -Infinity, active = 0, peak = 0, peakActors = 0, workers = 0;
    let stopped = false, failed = false, errorStatus: number | null = null, reads = 0, historyRows = 0, activeIds = 0;
    let initialFrustration: number | null = null, finalFrustration: number | null = null;
    let assistance = 0, assisted = 0, handoffs = 0, adminChecks = 0, journeys = 0, http = 0, loginHttp = 0;
    const counts: Record<string, number> = {};
    const profiles: Record<string, number> = {};
    const staffSessions: Staff['role'][] = [];
    const guard = async () => {
      if (failed || stopped || Date.now() >= end) throw new Finished();
      if (await access('reports/phase6-' + id + '.stop').then(() => true, () => false)) {
        stopped = true; throw new Finished();
      }
    };
    let ticket = Promise.resolve();
    const wrap = (origin: string): Transport => {
      const transport = new HttpTransport(origin, { ...cfg, retries: 0, allowWrites: true, timeoutMs: 3000 }, event => {
        if (event.operation === 'central.login') loginHttp++; else http++;
        counts[event.operation] = (counts[event.operation] ?? 0) + 1;
        if (!event.status || event.status >= 400) { failed = true; errorStatus ??= event.status; }
      });
      return { async send<T>(request: Request, decode: Decoder<T>) {
        const slot = ticket.then(async () => {
          while (active >= cfg.concurrency) { await guard(); await delay(20); }
          await delay(Math.max(0, Math.ceil(1000 / preset.httpRate - (performance.now() - last))));
          await guard();
          last = performance.now(); active++; peak = Math.max(peak, active);
        });
        ticket = slot.catch(() => {});
        await slot;
        try { return await transport.send(request, decode); }
        finally { active--; }
      }};
    };
    const api = new CentralApi(wrap(cfg.central), false);
    const sessions: CentralSession[] = [];
    const administrators: CentralSession[] = [];
    let advisor: CentralSession | undefined;
    let failure: string | null = null;
    try {
      if (!people.length) throw Error('pool-empty');
      for (const p of people) sessions.push(await api.login(p.email, p.password, 'PATIENT'));
      const attention = plan.preset === 'atencion';
      if (attention) {
        const staff = await privateRows<Staff>(localTarget.folder + '/cohort-staff.jsonl');
        for (const role of ['ADVISOR','ADMIN'] as const) {
          const email = process.env['SIM_' + role + '_EMAIL'], password = process.env['SIM_' + role + '_PASSWORD'];
          if (email && password && !staff.some(x => x.email === email)) staff.push({ role, email, password });
        }
        if (staff.length > 4 || new Set(staff.map(s => s.email)).size !== staff.length ||
            staff.some(s => !['ADVISOR','ADMIN'].includes(s.role) || !s.email.endsWith('@example.test') || !s.password)) throw Error('staff-config');
        const advisors = staff.filter(s => s.role === 'ADVISOR');
        // One assistance reference per run. Rotate the eligible advisor by run ID.
        const index = Array.from(id).reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
        const chosen = advisors.length ? advisors[index % advisors.length] : undefined;
        const selected = [...staff.filter(s => s.role === 'ADMIN'), ...(chosen ? [chosen] : [])];
        for (const s of selected) {
          const session = await api.login(s.email, s.password, s.role);
          if (s.role === 'ADMIN') administrators.push(session); else advisor = session;
          staffSessions.push(s.role);
        }
      }
      begin = Date.now(); end = begin + plan.seconds * 1000;
      const patient = async (session: CentralSession, i: number) => {
        const random = seededRandom(cfg.seed + i + 1);
        const profile = attention && i === 0 ? 'frustrado' : i % 2 ? 'frecuente' : 'citas';
        const wait = async (ms: number) => { await delay(Math.min(ms, Math.max(0, end - Date.now()))); await guard(); };
        workers++; peakActors = Math.max(peakActors, workers);
        try {
          const result = await runProfile(profile, { api, patient: session, advisor: profile === 'frustrado' ? advisor : undefined,
            behavior: { seed: cfg.seed + i, initial: 95, mode: 'initial', retryBudget: 0, delayMs: 700, canConverse: false,
              allowAssistanceRequest: attention, timing: { now: Date.now, wait } } });
          if (failed) throw Error('http');
          const outcome = result.outcome as { initial?: number; final?: number; assisted?: boolean; assistance?: boolean; resumed?: boolean; appointments?: number };
          if ((profile === 'citas' && !outcome.appointments) || (profile === 'frecuente' && !outcome.resumed)) throw Error('empty-data');
          if (profile === 'frustrado') { initialFrustration = outcome.initial ?? null; finalFrustration = outcome.final ?? null; }
          if (outcome.assistance) assistance++;
          if (outcome.assisted) assisted++;
          profiles[profile] = (profiles[profile] ?? 0) + 1;
          activeIds++;
          // Subsequent decisions are reads against the same authenticated identity.
          while (true) {
            await wait(250 + Math.floor(random() * 650));
            if (profile === 'frecuente' && random() < .6) {
              const pending = await api.requests(session, { limit: 3 }, true);
              if (!pending.items.length) throw Error('empty-data');
            } else {
              const page = await api.appointments(session, { limit: 3 }, true);
              const current = page.items[0];
              if (!current) throw Error('empty-data');
              const history = await api.history(session, current.requestId);
              if (!history.some(event => event.type === 'APPOINTMENT_CONFIRMED' && event.payload.appointmentId === current.id)) throw Error('empty-history');
              historyRows += history.length;
            }
            reads++;
          }
        } finally { workers--; }
      };
      const tasks: Promise<unknown>[] = sessions.map(patient);
      if (attention) {
        const channels = (name: 'web' | 'whatsapp' | 'call-center', prefix: string) => {
          const key = process.env[prefix + '_KEY'], expectedCode = process.env[prefix + '_CODE'];
          if (!key || !expectedCode) throw Error('channels');
          return { channel: name, key, expectedCode };
        };
        tasks.push((async () => {
          const result = await continuity(api, new Orchestrator(wrap(cfg.orchestrator), cfg.enabledChannels, true), {
            web: channels('web', 'SIM_WEB'), whatsapp: channels('whatsapp', 'SIM_WHATSAPP'), callCenter: channels('call-center', 'SIM_CALL_CENTER') });
          handoffs = result.handoffs; journeys++;
        })());
        for (const admin of administrators) tasks.push(api.adminOverview(admin).then(() => { adminChecks++; }));
      }
      await Promise.all(tasks.map(async task => {
        try { await task; } catch (e) { if (!(e instanceof Finished)) { failed = true; failure ??= e instanceof Error && ['empty-data','empty-history','channels'].includes(e.message) ? e.message : 'operation'; } }
      }));
      if (!stopped && (activeIds !== sessions.length || !historyRows || attention && (!journeys || !assistance))) failed = true;
    } catch (e) { if (!stopped) { failed = true; failure ??= e instanceof Error && ['pool-empty','staff-config'].includes(e.message) ? e.message : 'setup'; } }
    const state = failed ? 'failed' : stopped ? 'cancelled' : 'completed';
    const result = { kind: 'functional-real', state, dataset: localTarget.dataset, preset: plan.preset, startedAt,
      secondsRequested: plan.seconds, elapsedMs: begin ? Date.now() - begin : 0, targetHttpPerSecond: preset.httpRate,
      patientLimit: plan.patients, authenticatedPatients: sessions.length, activePatients: activeIds, peakConcurrentActors: peakActors,
      profiles, http, loginHttp, counts, peakHttpConcurrency: peak, populatedDecisions: reads, historyRowsRead: historyRows,
      initialFrustration, finalFrustration, assistance, assisted, journeys, handoffs, staffSessions, adminChecks, failure, errorStatus };
    await writeFile(reportPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (failed) process.exitCode = 1;
  } finally { await lock.close(); await unlink(lockPath); }
}
main().catch(() => { console.error('El grupo no superó la validación local.'); process.exitCode = 1; });
