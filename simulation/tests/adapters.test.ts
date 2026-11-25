import assert from 'node:assert/strict';
import test from 'node:test';
import { CentralApi, type CentralSession } from '../adapters/central-api/index.js';
import { Orchestrator, newIdempotencyKey } from '../adapters/orchestrator/index.js';
import { HttpTransport, HttpError, NetworkError } from '../adapters/transport/index.js';
import { readConfig } from '../config/index.js';
import { CapabilityError, ContractError, requestId } from '../contracts/index.js';
import { continuity } from '../scenarios/index.js';

const fixtureId = '00000000-0000-4000-8000-000000000001';
const fixtureStudyId = '00000000-0000-4000-8000-000000000002';
const fixtureClinicId = '00000000-0000-4000-8000-000000000003';
const fixtureTime = '2030-01-01T00:00:00.000Z';
const fixtureExpiry = '2099-01-01T00:00:00.000Z';
const fixtureSession: CentralSession = { role: 'PATIENT', token: 'fixture-token', expiresAt: fixtureExpiry };
const fixtureSnapshot = { id: fixtureId, type: 'APPOINTMENT', status: 'IN_PROGRESS', currentStep: 'SELECT_CLINIC',
  lastChannel: 'WEB', version: 2, context: { studyId: fixtureStudyId }, createdAt: fixtureTime,
  updatedAt: fixtureTime, completedAt: null };
const fixtureChannels = { web: { channel: 'web', key: 'fixture-web', expectedCode: 'fixture-web' },
  whatsapp: { channel: 'whatsapp', key: 'fixture-whatsapp', expectedCode: 'fixture-whatsapp' },
  callCenter: { channel: 'call-center', key: 'fixture-call', expectedCode: 'fixture-call' } } as const;

function fixture(configEnv: Record<string, string>, fetcher: typeof fetch) {
  const config = readConfig(configEnv);
  const transport = new HttpTransport(config.central, config, undefined, fetcher);
  return { transport, central: new CentralApi(transport, config.capabilities.conversation),
    orchestrator: new Orchestrator(transport, config.enabledChannels, config.capabilities.continuity) };
}

test('write and remote gates prevent any transport call', async () => {
  const fetcher: typeof fetch = async () => assert.fail('fixture transport should not be reached');
  await assert.rejects(fixture({}, fetcher).central.create(fixtureSession), CapabilityError);
  await assert.rejects(fixture({ SIM_ENV: 'test', SIM_CENTRAL_URL: 'https://example.test' }, fetcher).central.health(), CapabilityError);
  await assert.rejects(fixture({ SIM_CENTRAL_URL: 'https://example.test' }, fetcher).central.health(), CapabilityError);
  await assert.rejects(fixture({}, fetcher).orchestrator.list(fixtureChannels.web, 'fixture-assertion'), CapabilityError);
});

test('central adapter preserves version/role and rejects unknown response shapes', async () => {
  let calls = 0;
  const { central } = fixture({ SIM_ALLOW_WRITES: 'true' }, async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, '/api/v1/requests/' + fixtureId + '/context');
    assert.equal(init?.method, 'PATCH');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-token');
    assert.deepEqual(JSON.parse(String(init.body)), { version: 1, studyId: fixtureStudyId });
    return Response.json(calls === 1 ? fixtureSnapshot : { ...fixtureSnapshot, version: '2' });
  });
  const id = requestId(fixtureId);
  assert.throws(() => central.update({ ...fixtureSession, role: 'ADMIN' }, id, { version: 1 }), CapabilityError);
  assert.throws(() => central.converse(fixtureSession, { message: 'fixture' }), CapabilityError);
  assert.equal((await central.update(fixtureSession, id, { version: 1, studyId: fixtureStudyId })).version, 2);
  await assert.rejects(central.update(fixtureSession, id, { version: 1, studyId: fixtureStudyId }), ContractError);
});

test('transport respects Retry-After, suppresses response bodies and never replays an uncertain POST', async () => {
  let count = 0;
  const { central } = fixture({}, async () => {
    count++;
    return count === 1 ? new Response('fixture private body', { status: 429, headers: { 'Retry-After': '0' } })
      : Response.json({ status: 'ok' });
  });
  assert.equal(await central.health(), 'ok');
  assert.equal(count, 2);
  const delayed = fixture({}, async () => new Response('fixture secret', { status: 429, headers: { 'Retry-After': '90' } }));
  await assert.rejects(delayed.central.health(), (error: unknown) =>
    error instanceof HttpError && error.message === 'HTTP 429' && error.retryAfterMs === 90_000);
  count = 0;
  const uncertain = fixture({ SIM_ALLOW_WRITES: 'true' }, async () => {
    count++;
    throw new Error('fixture secret');
  });
  await assert.rejects(uncertain.central.create(fixtureSession), NetworkError);
  assert.equal(count, 1);
});

test('orchestrator uses the supplied idempotency key, validates grant expiry and channel', async () => {
  const key = newIdempotencyKey();
  const { orchestrator } = fixture({ SIM_ALLOW_WRITES: 'true' }, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('idempotency-key'), key);
    assert.deepEqual(JSON.parse(String(init?.body)), { type: 'APPOINTMENT' });
    return Response.json({ id: fixtureId, status: 'DRAFT', grant: 'fixture-grant', grantExpiresAt: fixtureExpiry }, { status: 201 });
  });
  const result = await orchestrator.create(fixtureChannels.web, key);
  assert.ok(result.grant);
  const grant = result.grant;
  assert.throws(() => orchestrator.context(fixtureChannels.whatsapp, grant), CapabilityError);
  assert.throws(() => orchestrator.context(fixtureChannels.web, { ...grant, expiresAt: '2000-01-01T00:00:00Z' }), CapabilityError);
});

test('two-hop scenario checks the same journey, new grants, context versions and producers (fixtures)', async () => {
  const prefix = '/api/v1';
  const base = { journeyId: fixtureId, updatedAt: fixtureTime };
  const event = (id: string, producerCode: string) => ({ id, producerCode, type: 'JOURNEY_CONTEXT_UPDATED',
    occurredAt: fixtureTime, receivedAt: fixtureTime, schemaVersion: 1, data: {} });
  const steps: [string, string, unknown, number?, string?][] = [
    ['GET', '/channel-auth/verify', { authenticated: true, channelCode: 'fixture-web', scopes: ['EVENTS_PUBLISH', 'JOURNEYS_READ'] }],
    ['GET', '/channel-auth/verify', { authenticated: true, channelCode: 'fixture-whatsapp', scopes: ['EVENTS_PUBLISH', 'JOURNEYS_READ'] }],
    ['GET', '/channel-auth/verify', { authenticated: true, channelCode: 'fixture-call', scopes: ['JOURNEYS_READ'] }],
    ['GET', '/studies', { items: [{ id: fixtureStudyId, name: 'Fixture study' }], page: 1, limit: 1, hasMore: false }],
    ['GET', '/clinics', { items: [{ id: fixtureClinicId, name: 'Fixture clinic' }], page: 1, limit: 1, hasMore: false }],
    ['POST', '/journeys', { id: fixtureId, status: 'DRAFT', grant: 'fixture-grant-web', grantExpiresAt: fixtureExpiry }, 201],
    ['GET', '/journeys/' + fixtureId + '/context', { ...base, currentStep: 'SELECT_STUDY', version: 1, externalRefs: {} }, 200, 'fixture-grant-web'],
    ['POST', '/events', { id: fixtureStudyId, journeyId: fixtureId }, 201, 'fixture-grant-web'],
    ['POST', '/journeys/' + fixtureId + '/continuity-codes', { code: 'fixture-code-web', expiresAt: fixtureExpiry }, 201, 'fixture-grant-web'],
    ['POST', '/continuity-codes/redeem', { journeyId: fixtureId, grant: 'fixture-grant-whatsapp', grantExpiresAt: fixtureExpiry }, 201],
    ['GET', '/journeys/' + fixtureId + '/context', { ...base, currentStep: 'SELECT_CLINIC', version: 2, externalRefs: { studyId: fixtureStudyId } }, 200, 'fixture-grant-whatsapp'],
    ['POST', '/events', { id: fixtureClinicId, journeyId: fixtureId }, 201, 'fixture-grant-whatsapp'],
    ['POST', '/journeys/' + fixtureId + '/continuity-codes', { code: 'fixture-code-whatsapp', expiresAt: fixtureExpiry }, 201, 'fixture-grant-whatsapp'],
    ['POST', '/continuity-codes/redeem', { journeyId: fixtureId, grant: 'fixture-grant-call', grantExpiresAt: fixtureExpiry }, 201],
    ['GET', '/journeys/' + fixtureId + '/context', { ...base, currentStep: 'REVIEW', version: 3, externalRefs: { studyId: fixtureStudyId, clinicId: fixtureClinicId } }, 200, 'fixture-grant-call'],
    ['GET', '/journeys/' + fixtureId + '/history', { items: [event(fixtureStudyId, 'fixture-web'), event(fixtureClinicId, 'fixture-whatsapp')] }, 200, 'fixture-grant-call'],
  ];
  let index = 0;
  const observed: (string | null)[] = [];
  const { central, orchestrator } = fixture({ SIM_ALLOW_WRITES: 'true', SIM_CONTINUITY: 'true' }, async (url, init) => {
    const entry = steps[index++];
    if (!entry) return new Response(null, { status: 500 });
    const [method, path, body, status, grant] = entry;
    assert.equal(init?.method, method);
    assert.equal(new URL(String(url)).pathname, prefix + path);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('x-journey-grant'), grant ?? null);
    if (path === '/continuity-codes/redeem') observed.push(headers.get('authorization'));
    return Response.json(body, { status });
  });
  assert.deepEqual(await continuity(central, orchestrator, fixtureChannels), { handoffs: 2, version: 3, historyEntries: 2 });
  assert.equal(index, steps.length);
  assert.deepEqual(observed, ['Bearer fixture-whatsapp', 'Bearer fixture-call']);
});

test('institutional advisor assertion requires patient consent and a separate private channel key', async () => {
  const advisor: CentralSession = { ...fixtureSession, role: 'ADVISOR' };
  const { central } = fixture({ SIM_ALLOW_WRITES:'true' }, async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-token');
    assert.equal(headers.get('X-Patient-Assertion-Channel-Key'), 'fixture-key');
    if (String(url).endsWith('/patient-assertion-consents')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { advisorId:fixtureId, channel:'fixture-call' });
      return Response.json({ consent:'fixture-consent' });
    }
    assert.deepEqual(JSON.parse(String(init?.body)), { consent:'fixture-consent' });
    return Response.json({ assertion:'fixture-assertion' });
  });
  assert.throws(()=>central.patientAssertion(advisor,'fixture-key'), CapabilityError);
  const consent = await central.patientConsent(fixtureSession,'fixture-key',fixtureId,'fixture-call');
  assert.equal(await central.patientAssertion(advisor,'fixture-key',consent),'fixture-assertion');
});
