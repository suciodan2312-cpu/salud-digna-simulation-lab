import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../config/index.js';
import { patientFixtures } from '../data/index.js';
import { chooseProfile, FrustratedPatient, seededRandom } from '../engine/index.js';
import { frustrationTrace, scenarios } from '../scenarios/index.js';

test('fixture preview and profile decisions repeat for the same seed', () => {
  const config = readConfig({ SIM_RECORDS: '5000000', SIM_SEED: '741' });
  const sample = () => {
    const random = seededRandom(config.seed);
    return Array.from({ length: 20 }, () => chooseProfile(config.weights, random));
  };
  assert.deepEqual(sample(), sample());
  assert.deepEqual(frustrationTrace(config), frustrationTrace(config));
  const stream = patientFixtures(config.seed, config.records);
  assert.deepEqual(stream.next().value, patientFixtures(config.seed, 1).next().value);
  assert.match(stream.next().value!.email, /741-2@example\.test$/);
});
test('configuration separates volumes, rejects unsafe or ambiguous options', () => {
  const config = readConfig({ SIM_ENV: 'test', SIM_CENTRAL_URL: 'https://example.test/api/v1', SIM_RATE: '17' });
  assert.equal(config.central, 'https://example.test');
  assert.equal(config.rate, 17);
  assert.equal(config.allowWrites, false);
  for (const env of [{ SIM_PROFILE_WEIGHTS: '{"resultados":1}' }, { SIM_RECORDS: '5000001' },
    { SIM_CENTRAL_URL: 'https://user:secret@example.test' }, { SIM_CHANNELS: 'web,web' }]) {
    assert.throws(() => readConfig(env));
  }
  assert.equal(scenarios.results.mode, 'blocked');
  assert.equal(scenarios.progressive.mode, 'planned');
});
test('frustration observes retry budget, escalation, abandonment and recovery', () => {
  const patient = new FrustratedPatient({ initial: 0, retryBudget: 1 }, () => 0.9);
  const available = { safeRetry: true, canSwitch: true, canAssist: true };
  assert.equal(patient.decide('delay', available), 'retry');
  assert.equal(patient.decide('error', available), 'wait');
  assert.equal(patient.decide('conflict', available), 'switch');
  assert.equal(patient.decide('repeated', available), 'assist');
  assert.equal(patient.decide('unresolved', available), 'abandon');
  assert.equal(patient.decide('delay', available), 'wait');
  assert.equal(patient.decide('humanResolved', available), 'resume');
  assert.equal(patient.frustration, 50);
});
