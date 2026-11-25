import type { CentralApi, CentralSession } from '../adapters/central-api/index.js';
import { newIdempotencyKey, type ChannelCredential, type Orchestrator } from '../adapters/orchestrator/index.js';
import { HttpError } from '../contracts/index.js';
import { CapabilityError, ContractError, type RequestId } from '../contracts/index.js';
import type { Config } from '../config/index.js';
import { FrustratedPatient, seededRandom } from '../engine/index.js';
import type { Friction } from '../profiles/index.js';

export const scenarios = {
  basic: { mode: 'functional', purpose: 'salud y catálogo', writes: false },
  schedule: { mode: 'functional', purpose: 'crear y confirmar cita', writes: true },
  assisted: { mode: 'functional', purpose: 'referencia y confirmación por asesor', writes: true },
  continuity: { mode: 'functional', purpose: 'dos canjes con el mismo trámite', writes: true },
  frustrated: { mode: 'offline', purpose: 'simular decisiones ante fricción', writes: false },
  admin: { mode: 'functional', purpose: 'indicadores y listado de solicitudes', writes: true },
  'version-conflict': { mode: 'functional', purpose: 'relectura tras versión obsoleta', writes: true },
  idempotency: { mode: 'functional', purpose: 'mismo trámite con la misma clave', writes: true },
  'appointment-status': { mode: 'functional', purpose: 'consultar próximas citas', writes: true },
  'high-demand-reads': { mode: 'planned', purpose: 'meseta de lecturas en catálogo y cuentas preaprovisionadas', writes: false },
  progressive: { mode: 'planned', purpose: 'escalones de tasa y meseta sostenible', writes: false },
  recovery: { mode: 'planned', purpose: 'retorno a línea base tras fallo controlado', writes: false },
  results: { mode: 'blocked', purpose: 'consulta clínica sin contrato verificado', writes: false },
} as const;
export type Scenario = keyof typeof scenarios;

function check(ok: unknown, description: string): asserts ok {
  if (!ok) throw new ContractError(description);
}

export async function basic(central: CentralApi, orchestrator: Orchestrator) {
  await central.health();
  await central.health(true);
  await orchestrator.health();
  const study = await central.catalog('studies', { limit: 1 });
  const clinic = await central.catalog('clinics', { limit: 1 });
  return { checks: ['central.health', 'central.health.db', 'orchestrator.health', 'catalog'],
    catalogReady: Boolean(study.items.length && clinic.items.length) };
}
async function catalogSelection(central: CentralApi) {
  const study = (await central.catalog('studies', { limit: 1 })).items[0];
  const clinic = (await central.catalog('clinics', { limit: 1 })).items[0];
  if (!study || !clinic) throw new CapabilityError('catálogo de pruebas con estudio y clínica');
  return { studyId: study.id, clinicId: clinic.id };
}

export async function schedule(central: CentralApi, patient: CentralSession, advisor?: CentralSession) {
  const selection = await catalogSelection(central);
  const opened = await central.create(patient);
  const ready = await central.update(patient, opened.id, { version: opened.version,
    ...selection, scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
  check(ready.id === opened.id && ready.status === 'PENDING_CONFIRMATION', 'solicitud preparada');
  const grant = advisor ? await central.claim(advisor, await central.assistance(patient, ready.id)) : undefined;
  if (advisor && grant) {
    check(grant.requestId === ready.id, 'solicitud del asesor');
    const detail = await central.assisted(advisor, grant);
    check(detail.id === ready.id && detail.version === ready.version &&
      detail.context.studyId === selection.studyId && detail.context.clinicId === selection.clinicId,
    'contexto del asesor');
  }
  const appointment = await central.confirm(advisor ?? patient, ready.id, ready.version, grant);
  check(appointment.requestId === ready.id && appointment.status === 'CONFIRMED', 'cita confirmada');
  const history = await central.history(patient, ready.id);
  check(history.some(event => event.type === 'APPOINTMENT_CONFIRMED' &&
    event.channel === (advisor ? 'CALL_CENTER' : 'WEB') &&
    event.actorRole === (advisor ? 'ADVISOR' : 'PATIENT') && event.payload.appointmentId === appointment.id),
  'evento de confirmación');
  return { confirmed: true, assisted: Boolean(advisor), historyEntries: history.length };
}

const runtimeIds: { key: () => string; uuid: () => string } = { key: newIdempotencyKey, uuid: () => crypto.randomUUID() };

export async function continuity(central: CentralApi, orchestrator: Orchestrator,
  channels: { web: ChannelCredential; whatsapp: ChannelCredential; callCenter: ChannelCredential }, ids = runtimeIds) {
  const { web, whatsapp, callCenter } = channels;
  if (new Set([web.expectedCode, whatsapp.expectedCode, callCenter.expectedCode]).size !== 3) {
    throw new CapabilityError('tres canales del orquestador distintos');
  }
  await orchestrator.verify(web, ['JOURNEYS_READ', 'EVENTS_PUBLISH']);
  await orchestrator.verify(whatsapp, ['JOURNEYS_READ', 'EVENTS_PUBLISH']);
  await orchestrator.verify(callCenter, ['JOURNEYS_READ']);
  const { studyId, clinicId } = await catalogSelection(central);
  const created = await orchestrator.create(web, ids.key());
  if (!created.grant) throw new CapabilityError('grant de creación');
  const initial = await orchestrator.context(web, created.grant);
  const study = await orchestrator.publish(web, created.grant, { type: 'JOURNEY_CONTEXT_UPDATED',
    externalEventId: ids.uuid(), occurredAt: new Date().toISOString(), payload: { expectedVersion: initial.version, studyId } });
  const whatsGrant = await orchestrator.redeem(whatsapp, await orchestrator.issue(web, created.grant));
  check(whatsGrant.journeyId === created.id, 'continuidad en WhatsApp');
  const middle = await orchestrator.context(whatsapp, whatsGrant);
  check(middle.externalRefs.studyId === studyId && middle.version === initial.version + 1, 'contexto en WhatsApp');
  const clinic = await orchestrator.publish(whatsapp, whatsGrant, { type: 'JOURNEY_CONTEXT_UPDATED',
    externalEventId: ids.uuid(), occurredAt: new Date().toISOString(), payload: { expectedVersion: middle.version, clinicId } });
  const callGrant = await orchestrator.redeem(callCenter, await orchestrator.issue(whatsapp, whatsGrant));
  check(callGrant.journeyId === created.id, 'continuidad en Call Center');
  const final = await orchestrator.context(callCenter, callGrant);
  check(final.version === middle.version + 1 && final.externalRefs.studyId === studyId &&
    final.externalRefs.clinicId === clinicId, 'contexto en Call Center');
  const history = await orchestrator.history(callCenter, callGrant, { limit: 100 });
  check(history.items.some(event => event.id === study.id && event.producerCode === web.expectedCode) &&
    history.items.some(event => event.id === clinic.id && event.producerCode === whatsapp.expectedCode), 'productores del historial');
  return { handoffs: 2, version: final.version, historyEntries: history.items.length };
}

export async function institutionalRecovery(api: CentralApi, orch: Orchestrator, patient: CentralSession,
  source: ChannelCredential, destination: ChannelCredential, sourceKey: string, destinationKey: string, advisor?: CentralSession) {
  check(source.expectedCode !== destination.expectedCode, 'canales independientes');
  await orch.verify(source, ['JOURNEYS_READ','EVENTS_PUBLISH']);
  await orch.verify(destination, ['JOURNEYS_READ']);
  const opened = await orch.create(source, newIdempotencyKey(), await api.patientAssertion(patient, sourceKey));
  if (!opened.grant) throw new CapabilityError('grant de origen');
  const before = await orch.context(source, opened.grant);
  const { studyId } = await catalogSelection(api);
  const event = await orch.publish(source, opened.grant, { type: 'JOURNEY_CONTEXT_UPDATED', externalEventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(), payload: { expectedVersion: before.version, studyId } });
  const consent = advisor ? await api.patientConsent(patient, sourceKey, (await api.me(advisor)).id, destination.expectedCode) : undefined;
  const assertion = await api.patientAssertion(advisor ?? patient, destinationKey, consent);
  const active = await orch.list(destination, assertion, true);
  check(active.some(j => j.id === opened.id), 'trámite activo de la identidad');
  const grant = await orch.accessGrant(destination, opened.id, assertion);
  const context = await orch.context(destination, grant);
  const history = await orch.history(destination, grant, { limit: 100 });
  check(context.journeyId === opened.id && context.version === before.version + 1 && context.externalRefs.studyId === studyId &&
    history.items.some(e => e.id === event.id && e.producerCode === source.expectedCode), 'recuperación institucional');
  return { sameJourney: true, contextVersion: context.version, historyEntries: history.items.length };
}

export async function versionConflict(central: CentralApi, patient: CentralSession) {
  const selection = await catalogSelection(central);
  const opened = await central.create(patient);
  const updated = await central.update(patient, opened.id, { version: opened.version, studyId: selection.studyId });
  try {
    await central.update(patient, opened.id, { version: opened.version, clinicId: selection.clinicId });
    throw new ContractError('se esperaba HTTP 409 para la versión obsoleta');
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 409)) throw error;
  }
  const current = await central.read(patient, opened.id);
  check(current.version === updated.version && !current.context.clinicId, 'conflicto sin mutación');
  const resolved = await central.update(patient, opened.id, { version: current.version, clinicId: selection.clinicId });
  check(resolved.context.clinicId === selection.clinicId && resolved.version > current.version, 'relectura y actualización');
  return { conflict: 409, resolved: true };
}
export async function idempotency(orchestrator: Orchestrator, web: ChannelCredential, ids = runtimeIds) {
  await orchestrator.verify(web, ['JOURNEYS_READ', 'EVENTS_PUBLISH']);
  const key = ids.key();
  const first = await orchestrator.create(web, key);
  const repeated = await orchestrator.create(web, key);
  check(first.id === repeated.id, 'creación idempotente');
  if (!first.grant) throw new CapabilityError('grant de creación');
  const advance = { type: 'JOURNEY_CONTEXT_UPDATED' as const, externalEventId: ids.uuid(),
    occurredAt: new Date().toISOString(), payload: { expectedVersion: 1, studyId: ids.uuid() } };
  const accepted = await orchestrator.publish(web, first.grant, advance);
  const replayed = await orchestrator.publish(web, first.grant, advance);
  const context = await orchestrator.context(web, first.grant);
  check(accepted.id === replayed.id && context.version === 2, 'evento idempotente');
  return { sameJourney: true, sameEvent: true };
}
export async function admin(central: CentralApi, session: CentralSession) {
  const overview = await central.adminOverview(session);
  const page = await central.adminRequests(session, { limit: 10 });
  const first: RequestId | undefined = page.items[0]?.id;
  const history = first ? await central.history(session, first) : undefined;
  return { overview, listed: page.items.length, historyEntries: history?.length ?? null };
}

export function frustrationTrace(config: Config) {
  const patient = new FrustratedPatient(config.frustration, seededRandom(config.seed));
  const events: Friction[] = ['delay', 'conflict', 'repeated', 'unresolved', 'humanResolved', 'error'];
  return events.map(event => {
    const decision = patient.decide(event, { safeRetry: event === 'delay' || event === 'conflict',
      canSwitch: config.capabilities.continuity && config.enabledChannels.includes('whatsapp'),
      canAssist: config.enabledChannels.includes('call-center') });
    return { event, decision, frustration: patient.frustration };
  });
}
