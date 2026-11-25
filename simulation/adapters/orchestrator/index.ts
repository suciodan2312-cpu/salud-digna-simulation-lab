import { CapabilityError, ContractError, integer, journeyId, list, literal, object, requireFresh,
  status, string, timestamp, uuid, type Channel, type Decoder, type JourneyId } from '../../contracts/index.js';
import type { Request, Transport } from '../transport/index.js';

type Scope = 'JOURNEYS_READ' | 'EVENTS_PUBLISH';
export type ChannelCredential = { channel: Channel; key: string; expectedCode: string };
export type Grant = { channel: Channel; journeyId: JourneyId; token: string; expiresAt: string };
type Continuity = { source: Channel; code: string; expiresAt: string };
export type Advance = { externalEventId: string; occurredAt: string } & (
  { type: 'JOURNEY_CONTEXT_UPDATED'; payload: { expectedVersion: number; studyId?: string; clinicId?: string } } |
  { type: 'JOURNEY_STATUS_CHANGED'; payload: { expectedVersion: number; to: 'PENDING_CONFIRMATION' | 'CANCELLED' } }
);
const path = (id: JourneyId) => `/journeys/${uuid(id)}`;
export const newIdempotencyKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const summary = (raw: unknown) => {
  const row = object(raw);
  return { id: journeyId(row.id), type: string(row.type), status: status(row.status),
    createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) };
};

export class Orchestrator {
  constructor(private readonly transport: Transport, private readonly enabledChannels: readonly Channel[],
    private readonly hasContinuity: boolean) {}

  private call<T>(operation: string, route: string, decode: Decoder<T>, channel?: ChannelCredential,
    options: Omit<Request, 'operation' | 'path' | 'headers'> = {}, headers: Record<string, string> = {}) {
    if (channel && !this.enabledChannels.includes(channel.channel)) throw new CapabilityError('canal habilitado');
    return this.transport.send({ ...options, operation, path: '/api/v1' + route,
      headers: { ...headers, ...(channel && { authorization: `Bearer ${channel.key}` }) } }, decode);
  }
  private grantHeaders(channel: ChannelCredential, grant: Grant) {
    if (channel.channel !== grant.channel) throw new CapabilityError('grant de otro canal');
    requireFresh(grant.expiresAt, 'grant vigente');
    return { 'X-Journey-Grant': grant.token };
  }
  health() {
    return this.call('orchestrator.health', '/health', raw => literal(object(raw).status, 'ok'), undefined, { safeRetry: true });
  }
  async verify(channel: ChannelCredential, required: readonly Scope[] = ['JOURNEYS_READ']) {
    const result = await this.call('orchestrator.verify', '/channel-auth/verify', raw => {
      const row = object(raw);
      if (row.authenticated !== true) throw new ContractError('canal autenticado');
      return { code: string(row.channelCode), scopes: list(row.scopes, value => literal(value, 'JOURNEYS_READ', 'EVENTS_PUBLISH')) };
    }, channel, { safeRetry: true });
    if (result.code !== channel.expectedCode || !required.every(scope => result.scopes.includes(scope))) {
      throw new CapabilityError('código o scopes del canal');
    }
    return result;
  }
  create(channel: ChannelCredential, key: string, assertion?: string) {
    return this.call('orchestrator.create', '/journeys', raw => {
      const row = object(raw);
      const id = journeyId(row.id);
      const grant = row.grant === undefined && row.grantExpiresAt === undefined ? undefined
        : { channel: channel.channel, journeyId: id, token: string(row.grant), expiresAt: timestamp(row.grantExpiresAt) };
      return { id, status: literal(row.status, 'DRAFT'), grant };
    }, channel, { method: 'POST', expected: 201, body: { type: 'APPOINTMENT' } },
    { 'Idempotency-Key': key, ...(assertion && { 'X-Patient-Assertion': assertion }) });
  }
  list(channel: ChannelCredential, assertion: string, activeOnly = false) {
    return this.call('orchestrator.list', activeOnly ? '/journeys?active=true' : '/journeys', raw => list(object(raw).items, summary),
      channel, { writes: true }, { 'X-Patient-Assertion': assertion });
  }
  accessGrant(channel: ChannelCredential, id: JourneyId, assertion: string) {
    return this.call('orchestrator.accessGrant', path(id) + '/access-grants', raw => {
      const row = object(raw);
      if (journeyId(row.journeyId) !== id) throw new ContractError('trámite del permiso');
      const expiresAt = timestamp(row.grantExpiresAt);
      requireFresh(expiresAt, 'permiso vigente');
      return { channel: channel.channel, journeyId: id, token: string(row.grant), expiresAt };
    }, channel, { method: 'POST', expected: 201 }, { 'X-Patient-Assertion': assertion });
  }
  read(channel: ChannelCredential, grant: Grant) {
    return this.call('orchestrator.read', path(grant.journeyId), summary, channel,
      { writes: true }, this.grantHeaders(channel, grant));
  }
  context(channel: ChannelCredential, grant: Grant) {
    return this.call('orchestrator.context', path(grant.journeyId) + '/context', raw => {
      const row = object(raw);
      const refs = object(row.externalRefs);
      if (journeyId(row.journeyId) !== grant.journeyId) throw new ContractError('trámite del contexto');
      return { journeyId: grant.journeyId, version: integer(row.version, 1),
        currentStep: string(row.currentStep), updatedAt: timestamp(row.updatedAt),
        externalRefs: { studyId: refs.studyId === undefined ? undefined : uuid(refs.studyId),
          clinicId: refs.clinicId === undefined ? undefined : uuid(refs.clinicId),
          appointmentId: refs.appointmentId === undefined ? undefined : uuid(refs.appointmentId) } };
    }, channel, { writes: true }, this.grantHeaders(channel, grant));
  }
  history(channel: ChannelCredential, grant: Grant, options: { limit?: number; cursor?: string } = {}) {
    const query: string[] = [];
    if (options.limit !== undefined) query.push('limit=' + encodeURIComponent(String(options.limit)));
    if (options.cursor !== undefined) query.push('cursor=' + encodeURIComponent(options.cursor));
    return this.call('orchestrator.history', path(grant.journeyId) + '/history' + (query.length ? '?' + query.join('&') : ''), raw => {
      const row = object(raw);
      return { items: list(row.items, value => {
        const event = object(value);
        return { id: uuid(event.id), type: string(event.type), producerCode: string(event.producerCode),
          occurredAt: timestamp(event.occurredAt), receivedAt: timestamp(event.receivedAt),
          schemaVersion: integer(event.schemaVersion, 1), data: object(event.data) };
      }), nextCursor: row.nextCursor === undefined ? undefined : string(row.nextCursor) };
    }, channel, { writes: true }, this.grantHeaders(channel, grant));
  }
  publish(channel: ChannelCredential, grant: Grant, event: Advance) {
    return this.call('orchestrator.publish', '/events', raw => {
      const row = object(raw);
      if (journeyId(row.journeyId) !== grant.journeyId) throw new ContractError('trámite del evento');
      return { id: uuid(row.id), journeyId: grant.journeyId };
    }, channel, { method: 'POST', expected: 201, body: { ...event, journeyId: grant.journeyId, schemaVersion: 1 } },
    this.grantHeaders(channel, grant));
  }
  issue(channel: ChannelCredential, grant: Grant) {
    if (!this.hasContinuity) throw new CapabilityError('códigos de continuidad');
    return this.call('orchestrator.issue', path(grant.journeyId) + '/continuity-codes', raw => {
      const row = object(raw);
      return { source: channel.channel, code: string(row.code), expiresAt: timestamp(row.expiresAt) };
    }, channel, { method: 'POST', expected: 201 }, this.grantHeaders(channel, grant));
  }
  redeem(channel: ChannelCredential, code: Continuity): Promise<Grant> {
    if (!this.hasContinuity || code.source === channel.channel) throw new CapabilityError('canje entre canales');
    requireFresh(code.expiresAt, 'código de continuidad vigente');
    return this.call('orchestrator.redeem', '/continuity-codes/redeem', raw => {
      const row = object(raw);
      return { channel: channel.channel, journeyId: journeyId(row.journeyId),
        token: string(row.grant), expiresAt: timestamp(row.grantExpiresAt) };
    }, channel, { method: 'POST', expected: 201, body: { code: code.code } });
  }
}
