import { Faker, en, es_MX } from '@faker-js/faker';
import { createHash } from 'node:crypto';

export const schemaSha = 'ff989ccd6e1062a5508e8f92cefbf17b7830896b';
export const referenceDate = '2026-11-24T00:00:00.000Z';
export const corpusVersion = 1;
export const tables = {
  central: {
    Patient: 'id firstName lastName email createdAt updatedAt',
    User: 'id email role patientId createdAt updatedAt',
    Clinic: 'id name address city state createdAt updatedAt',
    Study: 'id name price createdAt updatedAt',
    ServiceRequest: 'id patientId type status currentStep lastChannel version createdAt updatedAt completedAt',
    RequestContext: 'id requestId data updatedAt',
    Appointment: 'id requestId patientId clinicId studyId scheduledAt status createdAt updatedAt',
    Interaction: 'id requestId patientId channel actorUserId type createdAt',
    DomainEvent: 'id requestId patientId type channel actorUserId payload createdAt',
    AuditLog: 'id actorUserId action entityType entityId createdAt',
  },
  orchestrator: {
    Channel: 'id code name createdAt',
    PatientSubject: 'id createdAt',
    Journey: 'id patientSubjectId type status createdAt updatedAt',
    JourneyContext: 'journeyId currentStep version externalRefs updatedAt',
    JourneyEvent: 'id journeyId producerId externalEventId type schemaVersion occurredAt receivedAt payload',
    AccessAudit: 'id channelId patientSubjectId journeyId actorRef action outcome reasonCode createdAt',
  },
} as const;

export type Service = keyof typeof tables;
export const services: Service[] = ['central', 'orchestrator'];
export type Scalar = string | number | null | object;
export type Row = { service: Service; table: string; values: Scalar[] };
export const tableEntries = (service: Service) => Object.entries(tables[service]);
export const fileName = (service: Service, table: string) => `${service}-${table}.copy`;

export function datasetId(seed: number, count: number, reference: string) {
  return createHash('sha256').update(JSON.stringify([corpusVersion, schemaSha, seed, count, reference])).digest('hex').slice(0, 24);
}
export function copyLine(values: Scalar[]) {
  return values.map(value => value === null ? '\\N' :
    (typeof value === 'object' ? JSON.stringify(value) : String(value))
      .replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r')).join('\t') + '\n';
}
export function validateInputs(seed: number, count: number, reference: string) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff ||
      !Number.isInteger(count) || count < 1 || count > 5_000_000 ||
      !Number.isFinite(Date.parse(reference)) || new Date(reference).toISOString() !== reference ||
      new Date(Date.parse(reference) - 366 * 86_400_000).getUTCFullYear() < 2000 ||
      new Date(reference).getUTCFullYear() > 2099) throw new Error('Parámetros de corpus inválidos');
}

// Each full group is self-contained, except for shared synthetic catalogs and the historical channel.
export function* corpus(seed: number, count: number, reference = referenceDate): Generator<Row> {
  validateInputs(seed, count, reference);
  const faker = new Faker({ locale: [es_MX, en] });
  faker.seed(seed);
  const id = (service: Service, table: number, index: number) =>
    `${seed.toString(16).padStart(8, '0')}-${service === 'central' ? 'c001' : 'd001'}-4000-8${table.toString(16).padStart(3, '0')}-${index.toString(16).padStart(12, '0')}`;
  const clinic = id('central', 3, 0), study = id('central', 4, 0), channel = id('orchestrator', 1, 0);
  const when = (i: number, seconds = 0) =>
    new Date(Date.parse(reference) - (86400 * (3 + i % 360) - seconds) * 1000).toISOString();
  const central = (table: keyof typeof tables.central, ...values: Scalar[]): Row => ({ service: 'central', table, values });
  const orch = (table: keyof typeof tables.orchestrator, ...values: Scalar[]): Row => ({ service: 'orchestrator', table, values });
  const subjectIndex = (i: number) => (Math.imul(i, 104729) + 31337) & 0xffffff;
  const patient = (i: number) => central('Patient', id('central', 1, i), faker.person.firstName(), faker.person.lastName(),
    `historial-${seed}-${i}@example.test`, when(i), when(i));

  const groupSize = 19;
  if (count < 4 + groupSize) {
    for (let i = 0; i < count; i++) yield i % 2 === 0 ? patient(i) : orch('PatientSubject', id('orchestrator', 2, subjectIndex(i)), when(i));
    return;
  }
  yield central('Clinic', clinic, 'Clínica Fixture', 'Domicilio sintético', 'Ciudad Fixture', 'Estado Fixture', when(0), when(0));
  yield central('Study', study, 'Estudio Fixture', '120.00', when(0), when(0));
  yield orch('Channel', channel, `fixture-history-${seed}`, 'Canal histórico sintético', when(0));

  const admin = id('central', 2, 0x800000);
  yield central('User', admin, 'fixture-admin-' + seed + '@example.test', 'ADMIN', null, when(0), when(0));
  const groups = Math.floor((count - 4) / groupSize);
  for (let i = 0; i < groups; i++) {
    const p = id('central', 1, i), u = id('central', 2, i), r = id('central', 5, i), a = id('central', 7, i);
    const started = when(i), selected = when(i, 60), paused = when(i, 90), closed = when(i, 120);
    const scheduledAt = when(i, 86400), s = id('orchestrator', 2, subjectIndex(i)), j = id('orchestrator', 3, subjectIndex(i));
    yield patient(i);
    // NULL passwordHash uses the schema default. Historical users cannot log in.
    yield central('User', u, `historial-${seed}-${i}@example.test`, 'PATIENT', p, started, started);
    yield central('ServiceRequest', r, p, 'APPOINTMENT', 'COMPLETED', 'CONFIRMED', 'WEB', 4, started, closed, closed);
    yield central('RequestContext', id('central', 6, i), r, { studyId: study, clinicId: clinic, scheduledAt }, selected);
    yield central('Appointment', a, r, p, clinic, study, scheduledAt, 'CONFIRMED', closed, closed);
    yield central('Interaction', id('central', 8, i), r, p, 'WEB', u, 'REQUEST_PAUSED', paused);
    const event = (sequence: number, type: string, payload: object, time: string) =>
      central('DomainEvent', id('central', 9, i * 8 + sequence), r, p, type, 'WEB', u, payload, time);
    yield event(0, 'REQUEST_CREATED', { version: 1 }, started);
    yield event(1, 'REQUEST_CONTEXT_UPDATED', { version: 2, currentStep: 'REVIEW' }, selected);
    yield event(2, 'REQUEST_STATUS_CHANGED', { version: 2, from: 'DRAFT', to: 'PENDING_CONFIRMATION' }, selected);
    yield event(3, 'REQUEST_PAUSED', { version: 3, from: 'WEB', to: 'WEB' }, paused);
    yield event(4, 'APPOINTMENT_CONFIRMED', { version: 4, appointmentId: a }, closed);
    yield event(5, 'REQUEST_STATUS_CHANGED', { version: 4, from: 'PENDING_CONFIRMATION', to: 'COMPLETED' }, closed);
    yield central('AuditLog', id('central', 10, i), admin, 'ADMIN_JOURNEY_VIEWED', 'ServiceRequest', r, when(i, 180));
    yield orch('PatientSubject', s, started);
    yield orch('Journey', j, s, 'APPOINTMENT', 'IN_PROGRESS', started, selected);
    yield orch('JourneyContext', j, 'SELECT_CLINIC', 2, { studyId: id('orchestrator', 8, i) }, selected);
    yield orch('JourneyEvent', id('orchestrator', 5, i * 2), j, channel, `system:created:${j}`,
      'JOURNEY_CREATED', 1, started, started, { version: 1 });
    yield orch('JourneyEvent', id('orchestrator', 5, i * 2 + 1), j, channel, `fixture-context:${i}`,
      'JOURNEY_CONTEXT_UPDATED', 1, selected, selected, { version: 2, currentStep: 'SELECT_CLINIC' });
    yield orch('AccessAudit', id('orchestrator', 6, i), channel, null, j, 'fixture-history',
      'CHANGE_JOURNEY_STATUS', 'ALLOWED', 'JOURNEY_CREATED', started);
  }
  for (let i = groups; i < groups + (count - 4) % groupSize; i++) {
    yield i % 2 === 0 ? patient(i) : orch('PatientSubject', id('orchestrator', 2, subjectIndex(i)), when(i));
  }
}
