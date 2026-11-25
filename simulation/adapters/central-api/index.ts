import type { Transport, Request } from '../transport/index.js';
import { CapabilityError, ContractError, integer, list, literal, object, page, requestId,
  requireFresh, status, string, timestamp, uuid, type Decoder, type RequestId, type Role } from '../../contracts/index.js';

type Session = { token: string; role: Role; expiresAt: string };
type Version = { version: number };
type Selection = { studyId?: string; clinicId?: string; scheduledAt?: string | null; notes?: string | null };
type Filters = { page?: number; limit?: number; status?: ReturnType<typeof status> };
type CatalogFilters = { page?: number; limit?: number; q?: string };
type Conversation = {
  message: string; requestId?: RequestId; version?: number;
  action?: { type: 'SELECT_STUDY' | 'SELECT_CLINIC' | 'SELECT_DATETIME'; value: string };
};

const role = (raw: unknown) => literal(raw, 'PATIENT', 'ADVISOR', 'ADMIN');
const selection = (raw: unknown) => {
  const row = object(raw);
  return { studyId: row.studyId === undefined ? undefined : uuid(row.studyId),
    clinicId: row.clinicId === undefined ? undefined : uuid(row.clinicId),
    scheduledAt: row.scheduledAt == null ? undefined : timestamp(row.scheduledAt),
    notes: row.notes == null ? undefined : string(row.notes) };
};
const channel = (raw: unknown) => literal(raw, 'WEB', 'WHATSAPP', 'MOBILE', 'CALL_CENTER');
const summary = (raw: unknown) => {
  const row = object(raw);
  return { id: requestId(row.id), status: status(row.status),
    currentStep: string(row.currentStep), lastChannel: channel(row.lastChannel),
    createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) };
};
const snapshot = (raw: unknown) => {
  const row = object(raw);
  return { ...summary(row), type: literal(row.type, 'APPOINTMENT'),
    version: integer(row.version, 1), context: selection(row.context),
    completedAt: row.completedAt === null ? null : timestamp(row.completedAt) };
};
const item = (raw: unknown) => {
  const row = object(raw);
  return { id: uuid(row.id), name: string(row.name) };
};
const appointment = (raw: unknown) => {
  const row = object(raw);
  return { id: uuid(row.id), requestId: requestId(row.requestId), study: item(row.study), clinic: item(row.clinic),
    status: literal(row.status, 'PENDING', 'CONFIRMED', 'CANCELLED'),
    scheduledAt: timestamp(row.scheduledAt), createdAt: timestamp(row.createdAt) };
};
const timeline = (raw: unknown) => list(raw, entry => {
  const row = object(entry);
  return { id: uuid(row.id), type: string(row.type), channel: channel(row.channel),
    createdAt: timestamp(row.createdAt), actorRole: row.actorRole === null ? null : role(row.actorRole),
    payload: object(row.payload) };
});
const expiry = (raw: unknown) => {
  const row = object(raw);
  return { code: string(row.code), expiresAt: timestamp(row.expiresAt) };
};
const account = (raw: unknown) => {
  const row = object(raw);
  return { id: uuid(row.id), email: string(row.email), role: role(row.role),
    patientId: row.patientId === null ? null : uuid(row.patientId) };
};
function query(options: Record<string, string | number | undefined>) {
  const params = Object.entries(options).filter(([, value]) => value !== undefined)
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  return params.length ? '?' + params.join('&') : '';
}
const requestPath = (id: RequestId) => `/requests/${uuid(id)}`;
const assistedPath = (id: RequestId) => `/call-center${requestPath(id)}`;

export class CentralApi {
  constructor(private readonly transport: Transport, private readonly hasConversation: boolean) {}

  private call<T>(operation: string, path: string, decode: Decoder<T>,
    options: Omit<Request, 'operation' | 'path' | 'headers'> = {},
    session?: Session, allowed?: Role | readonly Role[], assertionKey?: string) {
    if (session) {
      requireFresh(session.expiresAt, 'sesión central vigente');
      if (allowed && !(typeof allowed === 'string' ? allowed === session.role : allowed.includes(session.role))) {
        throw new CapabilityError('rol central requerido');
      }
    }
    return this.transport.send({ ...options, operation, path: '/api/v1' + path,
      headers: session && { authorization: `Bearer ${session.token}`, ...(assertionKey && { 'X-Patient-Assertion-Channel-Key': assertionKey }) } }, decode);
  }

  patientConsent(patient: Session, sourceKey: string, advisorId: string, channel: string) {
    return this.call('central.patientConsent', '/auth/patient-assertion-consents', raw => string(object(raw).consent),
      { method: 'POST', body: { advisorId: uuid(advisorId), channel } }, patient, 'PATIENT', sourceKey);
  }
  patientAssertion(session: Session, key: string, consent?: string) {
    if (!key || (session.role === 'ADVISOR') !== Boolean(consent)) throw new CapabilityError('acreditación de canal');
    return this.call('central.patientAssertion', '/auth/patient-assertions', raw => string(object(raw).assertion),
      { method: 'POST', body: consent ? { consent } : {} }, session, ['PATIENT','ADVISOR'], key);
  }
  health(db = false) {
    return this.call(db ? 'central.health.db' : 'central.health', db ? '/health/db' : '/health',
      raw => literal(object(raw).status, 'ok'), { safeRetry: true });
  }
  register(body: { firstName: string; lastName: string; email: string; password: string; phone?: string }) {
    return this.call('central.register', '/auth/register', account, { method: 'POST', body, expected: 201 });
  }
  login(email: string, password: string, expectedRole: Role) {
    return this.call('central.login', '/auth/login', raw => {
      const row = object(raw);
      literal(row.tokenType, 'Bearer');
      if (role(object(row.user).role) !== expectedRole) throw new ContractError('rol de sesión');
      return { token: string(row.accessToken), role: expectedRole,
        expiresAt: new Date(Date.now() + integer(row.expiresIn, 1) * 1000).toISOString() };
    }, { method: 'POST', body: { email, password } });
  }
  me(session: Session) { return this.call('central.me', '/auth/me', account, {}, session); }
  catalog(kind: 'clinics' | 'studies', options: CatalogFilters = {}) {
    return this.call(`central.${kind}`, '/' + kind + query(options), raw => page(raw, item), { safeRetry: true });
  }
  requests(session: Session, options: Filters = {}, pending = false) {
    const filters = pending ? { page: options.page, limit: options.limit } : options;
    return this.call(pending ? 'central.pending' : 'central.requests',
      (pending ? '/requests/pending' : '/requests') + query(filters), raw => page(raw, snapshot),
      { safeRetry: true }, session, 'PATIENT');
  }
  create(session: Session) {
    return this.call('central.create', '/requests', snapshot,
      { method: 'POST', body: { type: 'APPOINTMENT' }, expected: 201 }, session, 'PATIENT');
  }
  read(session: Session, id: RequestId) {
    return this.call('central.read', requestPath(id), snapshot, { safeRetry: true }, session, 'PATIENT');
  }
  update(session: Session, id: RequestId, body: Version & Selection) {
    return this.call('central.update', requestPath(id) + '/context', snapshot, { method: 'PATCH', body }, session, 'PATIENT');
  }
  transition(session: Session, id: RequestId, action: 'pause' | 'resume', version: number) {
    return this.call(`central.${action}`, requestPath(id) + '/' + action, snapshot,
      { method: 'POST', body: { version } }, session, 'PATIENT');
  }
  converse(session: Session, body: Conversation) {
    if (!this.hasConversation) throw new CapabilityError('conversación de desarrollo');
    return this.call('central.conversation', '/conversations/dev/message', raw => {
      const row = object(raw);
      return { reply: string(row.reply), intent: string(row.intent),
        requestId: row.requestId === null ? null : requestId(row.requestId),
        currentStep: row.currentStep === null ? null : string(row.currentStep),
        requestStatus: row.requestStatus === null ? null : status(row.requestStatus),
        version: row.version === null ? null : integer(row.version, 1),
        suggestedActions: row.suggestedActions === undefined ? undefined : list(row.suggestedActions, value => {
          const action = object(value);
          return { type: literal(action.type, 'SELECT_STUDY', 'SELECT_CLINIC', 'SELECT_DATETIME',
            'SELECT_REQUEST', 'LIST_REQUESTS', 'REQUEST_ASSISTANCE'),
            label: string(action.label), value: action.value === undefined ? undefined : string(action.value),
            requestId: action.requestId === undefined ? undefined : requestId(action.requestId) };
        }) };
    }, { method: 'POST', body }, session, 'PATIENT');
  }
  assistance(session: Session, id: RequestId) {
    return this.call('central.assistance', requestPath(id) + '/assistance-code', expiry,
      { method: 'POST', expected: 201 }, session, 'PATIENT');
  }
  claim(session: Session, reference: ReturnType<typeof expiry>) {
    requireFresh(reference.expiresAt, 'referencia de asistencia vigente');
    return this.call('central.claim', '/call-center/claim', raw => {
      const row = object(raw);
      return { requestId: requestId(row.requestId), expiresAt: timestamp(row.expiresAt) };
    }, { method: 'POST', body: { code: reference.code } }, session, 'ADVISOR');
  }
  assisted(session: Session, grant: { requestId: RequestId; expiresAt: string }) {
    requireFresh(grant.expiresAt, 'permiso de asistencia vigente');
    return this.call('central.assisted', assistedPath(grant.requestId), raw => {
      const row = object(raw);
      return { ...snapshot(row), recentEvents: timeline(row.recentEvents) };
    }, { safeRetry: true }, session, 'ADVISOR');
  }
  confirm(session: Session, id: RequestId, version: number, grant?: { requestId: RequestId; expiresAt: string }) {
    if (grant) {
      requireFresh(grant.expiresAt, 'permiso de asistencia vigente');
      if (grant.requestId !== id) throw new CapabilityError('permiso de otra solicitud');
    }
    return this.call('central.confirm', (grant ? assistedPath(id) : requestPath(id)) + '/confirm', appointment,
      { method: 'POST', body: { version } }, session, grant ? 'ADVISOR' : 'PATIENT');
  }
  appointments(session: Session, options: { page?: number; limit?: number } = {}, upcoming = false) {
    return this.call('central.appointments', (upcoming ? '/appointments/upcoming' : '/appointments') + query(options),
      raw => page(raw, appointment), { safeRetry: true }, session, 'PATIENT');
  }
  history(session: Session, id: RequestId) {
    const admin = session.role === 'ADMIN';
    return this.call('central.history', (admin ? '/admin' : '') + requestPath(id) + '/journey', timeline,
      { writes: admin || session.role === 'ADVISOR' }, session, ['PATIENT', 'ADVISOR', 'ADMIN']);
  }
  adminOverview(session: Session) {
    return this.call('central.admin.overview', '/admin/overview', raw => {
      const row = object(raw);
      const counts = object(row.requestsByStatus);
      return { totalPatients: integer(row.totalPatients), requestsCreated: integer(row.requestsCreated),
        openRequests: integer(row.openRequests), completedRequests: integer(row.completedRequests),
        confirmedAppointments: integer(row.confirmedAppointments),
        requestsByStatus: { DRAFT: integer(counts.DRAFT), IN_PROGRESS: integer(counts.IN_PROGRESS),
          PENDING_CONFIRMATION: integer(counts.PENDING_CONFIRMATION), COMPLETED: integer(counts.COMPLETED),
          CANCELLED: integer(counts.CANCELLED) } };
    }, { safeRetry: true }, session, 'ADMIN');
  }
  adminRequests(session: Session, options: Filters = {}) {
    return this.call('central.admin.requests', '/admin/requests' + query(options), raw => page(raw, summary),
      { safeRetry: true }, session, 'ADMIN');
  }
}
export type CentralSession = Session;
