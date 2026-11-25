import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalKey, behaviorMix, large, legacy, million, readMix, validatePlan } from '../lib/policy.ts';
test('the actual inputs for a behavior plan survive validation and do not permit parallel actors', () => {
  const input = { dataset: legacy, scenario: 'behavior', seconds: 60, vus: 1, rate: 1,
    mix: { ...behaviorMix, frustrado: 0, citas: 100 }, seed: 314, waitMs: 250, initial: 75 };
  const plan = validatePlan(input);
  assert.deepEqual(plan, input);
  assert.equal(approvalKey(plan), 'behavior:60:1');
  assert.throws(() => validatePlan({ ...input, vus: 2 }));
  assert.throws(() => validatePlan({ ...input, mix: { ...behaviorMix, citas: 5 } }));
});
test('read traffic never receives side-effect profile allocations or remote destinations', () => {
  const input = { dataset: large, scenario: 'patient-reads', seconds: 300, vus: 5, rate: 10 };
  assert.equal(approvalKey(validatePlan({ ...input, dataset: million })), '1m:10:300:5');
  assert.throws(() => validatePlan({ ...input, mix: { ...readMix, frecuente: 49, omnicanal: 1 } }));
  assert.throws(() => validatePlan({ ...input, destination: 'https://example.test' }));
});
