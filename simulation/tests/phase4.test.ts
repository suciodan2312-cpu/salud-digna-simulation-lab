import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../config/index.js';
import { readLoadPlan } from '../load/plan.js';
import { runId } from '../local/control.js';
import { readLabUrl } from '../local/monitor.js';
import { frustrated } from '../engine/behavior.js';
import { CentralApi, type CentralSession } from '../adapters/central-api/index.js';
import { HttpError } from '../contracts/index.js';
import type { Request, Transport } from '../adapters/transport/index.js';
import type { Decoder } from '../contracts/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const expiresAt = '2099-01-01T00:00:00.000Z';
const current = { id, type: 'APPOINTMENT', status: 'DRAFT', currentStep: 'SELECT_STUDY', lastChannel: 'WEB',
  version: 1, context: {}, createdAt: expiresAt, updatedAt: expiresAt, completedAt: null };
const patient: CentralSession = { role: 'PATIENT', token: 'fixture', expiresAt };

test('high initial synthetic frustration can issue a reference without claiming human resolution', async () => {
  const fixture: Transport = { async send<T>({ operation }: Request, decode: Decoder<T>) {
    if (operation === 'central.pending') return decode({ items: [current], page: 1, limit: 1, hasMore: false });
    assert.equal(operation, 'central.assistance');
    return decode({ code: 'fixture-only', expiresAt });
  } };
  const result = await frustrated(new CentralApi(fixture, false), patient, { mode: 'initial', initial: 95, seed: 42,
    retryBudget: 2, delayMs: 500, canConverse: false, allowAssistanceRequest: true,
    timing: { now: () => 0, wait: async () => {} } });
  assert.equal(result.assistance, true);
  assert.equal(result.assisted, false);
  assert.equal(result.resolvedMs, undefined);
  assert.deepEqual(result.trace[0], { event: 'startingConcern', origin: 'synthetic', decision: 'assist', frustration: 95 });
  assert.equal(result.final, 100);
  assert.ok(!JSON.stringify(result).includes('fixture-only'));
});
test('observed permission rejection does not synthesize recovery', async () => {
  const fixture: Transport = { async send<T>({ operation }: Request, decode: Decoder<T>) {
    if (operation === 'central.pending') return decode({ items: [current], page: 1, limit: 1, hasMore: false });
    throw new HttpError(403);
  } };
  const result = await frustrated(new CentralApi(fixture, false), patient, { mode: 'observed', initial: 0, seed: 1,
    retryBudget: 2, delayMs: 500, canConverse: false, timing: { now: () => 0, wait: async () => {} } });
  assert.equal(result.denied, 1);
  assert.equal(result.trace[0]?.origin, 'observed');
  assert.equal(result.assisted, false);
  assert.equal(result.resolvedMs, undefined);
});
test('score bounds and execution IDs and monitored database ports are enforced', () => {
  assert.equal(readConfig({ SIM_FRUSTRATION_INITIAL: '100' }).frustration.initial, 100);
  assert.equal(readLoadPlan({ SIM_FRUSTRATION_MODE: 'initial' }).frustrationMode, 'initial');
  assert.throws(() => readConfig({ SIM_FRUSTRATION_INITIAL: '101' }));
  assert.throws(() => runId('../../report'));
  assert.throws(() => readLabUrl('central', { SIM_ENV: 'local',
    SIM_CENTRAL_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:5432/salud_digna_simulation' }));
});

test('warm read allocation includes iteration tail margin and respects the approved cap', async () => {
  const { warmReadVUs } = await import('../load/plan.js');
  assert.deepEqual([5,10,25,50,100].map(rate => warmReadVUs(rate, 20)), [4,4,5,8,14]);
  assert.equal(warmReadVUs(100, 10), 10);
});
