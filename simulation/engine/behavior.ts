import type { CentralApi, CentralSession } from '../adapters/central-api/index.js';
import { CapabilityError, ContractError, HttpError, NetworkError, type Channel } from '../contracts/index.js';
import { admin, continuity, schedule } from '../scenarios/index.js';
import { FrustratedPatient, seededRandom } from './index.js';
import type { Profile, Friction } from '../profiles/index.js';

type Orchestration = Parameters<typeof continuity>;
type Registration = Parameters<CentralApi['register']>[0];
type RequestSnapshot = Awaited<ReturnType<CentralApi['read']>>;
type TraceEvent = { origin: 'observed' | 'synthetic' | 'injected'; event: Friction; frustration: number; decision: string };
export type FrustrationReport = { initial: number; final: number; trace: TraceEvent[]; conflicts: number; throttled: number; requestErrors: number;
  mode: 'initial' | 'observed'; scale: 100; reReads: number; denied: number; abandoned: boolean; resumed: boolean; assistance: boolean; assisted: boolean; channel: Channel;
  resolvedMs?: number };
type Timing = { now: () => number; wait: (ms: number) => Promise<void> };
type BehaviorOptions = {
  seed: number; initial: number; retryBudget: number; delayMs: number; canConverse: boolean; timing: Timing;
  mode?: 'initial' | 'observed'; allowAssistanceRequest?: boolean; injectedEvent?: Friction;
};

export async function frustrated(api: CentralApi, patient: CentralSession, options: BehaviorOptions,
  advisor?: CentralSession): Promise<FrustrationReport> {
  const random = seededRandom(options.seed);
  const agent = new FrustratedPatient({ initial: options.initial, retryBudget: options.retryBudget }, random);
  const begin = options.timing.now();
  const trace: TraceEvent[] = [];
  const mode = options.mode ?? 'observed';
  const result: FrustrationReport = { mode, scale: 100, reReads: 0, denied: 0, initial: agent.frustration, final: agent.frustration, trace,
    conflicts: 0, throttled: 0, requestErrors: 0, abandoned: false, resumed: false, assistance: false, assisted: false, channel: 'web' };
  let request = (await api.requests(patient, { limit: 1 }, true)).items[0];
  if (!request) request = await api.create(patient);
  const react = (event: Friction, origin: TraceEvent['origin'], safeRetry = false) => {
    const decision = agent.decide(event, { safeRetry, canSwitch: options.canConverse && result.channel === 'web',
      canAssist: Boolean(advisor) || options.allowAssistanceRequest === true });
    trace.push({ event, origin, frustration: agent.frustration, decision });
    result.final = agent.frustration;
    return decision;
  };
  const delay = () => options.timing.wait(Math.floor(random() * 250));
  let needsResume = true;
  let pending: Pick<TraceEvent, 'event' | 'origin'> | undefined = options.injectedEvent
    ? { event: options.injectedEvent, origin: 'injected' }
    : mode === 'initial' ? { event: 'startingConcern', origin: 'synthetic' } : undefined;
  let reads = 0;
  for (let attempt = 0; attempt <= options.retryBudget + 2; attempt++) {
    await delay();
    const started = options.timing.now();
    let friction: Friction;
    let origin: TraceEvent['origin'];
    let safeRetry = true;
    if (pending) {
      ({ event: friction, origin } = pending);
      pending = undefined;
    } else {
      origin = 'observed';
      let writing = false;
      try {
        if (reads++ > 0) {
          result.reReads++;
          result.final = agent.observe('reread');
          trace.push({ event: 'reread', origin: 'observed', frustration: result.final, decision: 'reread' });
        }
        const current = await api.read(patient, request.id);
        if (current.id !== request.id) throw new ContractError('identidad de solicitud');
        request = current;
        if (needsResume && ['DRAFT', 'IN_PROGRESS', 'PENDING_CONFIRMATION'].includes(request.status)) {
          writing = true;
          request = await api.transition(patient, request.id, 'resume', request.version);
          needsResume = false;
          result.resumed = true;
        }
        if (options.timing.now() - started >= options.delayMs) friction = 'delay';
        else {
          result.resolvedMs = options.timing.now() - begin;
          break;
        }
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          result.conflicts++;
          friction = 'conflict';
        } else if (error instanceof HttpError && (error.status >= 500 || error.status === 429)) {
          friction = 'error';
          safeRetry = !writing && error.status !== 429;
          if (error.status === 429) result.throttled++; else result.requestErrors++;
        } else if (error instanceof HttpError && [400, 401, 403, 404, 422].includes(error.status)) {
          result.denied++;
          react('denied', 'observed');
          break;
        } else if (error instanceof NetworkError) {
          safeRetry = !writing;
          result.requestErrors++;
          friction = 'error';
        } else throw error;
      }
    }
    const decision = react(friction, origin, safeRetry);
    if (friction === 'error' && !safeRetry) break;
    if (decision === 'retry') continue;
    if (decision === 'switch') {
      const reply = await api.converse(patient, { message: 'Quiero continuar mi solicitud', requestId: request.id });
      if (reply.requestId !== request.id) throw new ContractError('continuidad conversacional');
      result.channel = 'whatsapp'; // Logical channel, central simulator preserves lastChannel.
      result.resolvedMs = options.timing.now() - begin;
    } else if (decision === 'assist') {
      const code = await api.assistance(patient, request.id);
      result.assistance = true;
      if (!advisor) break;
      const permission = await api.claim(advisor, code);
      if (permission.requestId !== request.id) throw new ContractError('solicitud asistida');
      const detail = await api.assisted(advisor, permission);
      if (detail.id !== request.id) throw new ContractError('contexto asistido');
      result.channel = 'call-center';
      result.assisted = true;
      react('humanResolved', 'observed');
      result.resolvedMs = options.timing.now() - begin;
    } else if (decision === 'abandon') {
      try {
        const paused = await api.transition(patient, request.id, 'pause', request.version);
        result.abandoned = true;
        if (random() < 0.5) {
          await delay();
          await api.transition(patient, request.id, 'resume', paused.version);
          result.resumed = true;
        }
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 409)) throw error;
        result.conflicts++;
        react('conflict', 'observed');
      }
    }
    break;
  }
  if (result.resolvedMs === undefined && !result.abandoned) {
    result.final = agent.observe('unresolved');
    trace.push({ event: 'unresolved', origin: 'synthetic', frustration: result.final, decision: 'wait' });
  }
  return result;
}

export async function runProfile(profile: Profile, input: { api: CentralApi; patient?: CentralSession;
  advisor?: CentralSession; administrator?: CentralSession; registration?: Registration;
  orchestration?: Orchestration; behavior: BehaviorOptions }) {
  const { api, advisor, administrator, registration, orchestration, behavior } = input;
  let { patient } = input;
  const start = behavior.timing.now();
  const random = seededRandom(behavior.seed);
  const decisionWaitMs = Math.floor(random() * 250);
  const result = (goal: string, channel: Channel, outcome: object) => ({
    profile, goal, channel, decisionWaitMs, elapsedMs: behavior.timing.now() - start, outcome,
  });
  function requireSession<T>(session: T | undefined, capability: string): T {
    if (!session) throw new CapabilityError(capability);
    return session;
  }
  if (profile === 'resultados') throw new CapabilityError('resultados clínicos');
  await behavior.timing.wait(decisionWaitMs);
  if (profile === 'administrador') return result('supervisar', 'web', await admin(api, requireSession(administrator, 'sesión ADMIN')));
  if (profile === 'omnicanal') return result('continuar trámite', 'call-center',
    await continuity(...requireSession(orchestration, 'canales del orquestador')));
  if (profile === 'nuevo') {
    const account = requireSession(registration, 'registro ficticio');
    await api.register(account);
    patient = await api.login(account.email, account.password, 'PATIENT');
  }
  const session = requireSession(patient, 'sesión PATIENT');
  if (profile === 'nuevo' || profile === 'asesor') return result('agendar', profile === 'asesor' ? 'call-center' : 'web',
    await schedule(api, session, profile === 'asesor' ? requireSession(advisor, 'sesión ADVISOR') : undefined));
  if (profile === 'frustrado') {
    const state = await frustrated(api, session, behavior, advisor);
    return result('recuperar contexto', state.channel, state);
  }
  if (profile === 'citas') {
    const page = await api.appointments(session, { limit: 10 }, true);
    return result('estado de citas', 'web', { appointments: page.items.length });
  }
  if (profile === 'frecuente') {
    const page = await api.requests(session, { limit: 1 }, true);
    const found = page.items[0];
    if (found) await api.transition(session, found.id, 'resume', found.version);
    return result('retomar', 'web', { resumed: Boolean(found) });
  }
  if (profile === 'dificultades' && !behavior.canConverse) throw new CapabilityError('conversación de desarrollo');
  const request = await api.create(session);
  if (profile === 'dificultades') {
    await behavior.timing.wait(500 + Math.floor(random() * 500));
    const help = await api.converse(session, { message: 'Ayuda', requestId: request.id });
    const snapshot = await api.read(session, request.id);
    const study = (await api.catalog('studies', { limit: 1 })).items[0];
    if (help.requestId !== snapshot.id || !study) throw new ContractError('asistencia conversacional');
    const reply = await api.converse(session, { message: 'Elijo este estudio', requestId: request.id,
      version: snapshot.version, action: { type: 'SELECT_STUDY', value: study.id } });
    if (reply.requestId !== request.id || reply.version === null || reply.version <= snapshot.version) {
      throw new ContractError('selección explícita');
    }
    return result('ayuda y selección explícita', 'whatsapp', { version: reply.version });
  }
  const studies = (await api.catalog('studies', { limit: 2 })).items;
  const clinic = (await api.catalog('clinics', { limit: 1 })).items[0];
  if (!studies[0] || !studies[1] || !clinic) throw new CapabilityError('dos estudios y una clínica de prueba');
  const chosen = await api.update(session, request.id, { version: request.version, studyId: studies[0].id, clinicId: clinic.id });
  const paused = await api.transition(session, request.id, 'pause', chosen.version);
  const resumed: RequestSnapshot = await api.transition(session, request.id, 'resume', paused.version);
  const changed = await api.update(session, request.id, { version: resumed.version, studyId: studies[1].id });
  if (changed.context.clinicId || changed.context.scheduledAt) throw new ContractError('invalidación de selecciones');
  return result('reconsiderar selección', 'web', { paused: true, resumed: true, changed: true });
}
