import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecution, large, legacy, requestAllowed, validatePlan, reportFile, approvalKey } from '../lib/policy.ts';
const valid = { dataset: large, scenario: 'patient-reads', rate: 5, seconds: 60, vus: 5 };
test('operator plan is bounded to allowlisted dataset, scenario, duration and rates', () => {
  assert.equal(approvalKey(validatePlan(valid)), '5:60:5');
  for (const invalid of [{ ...valid, dataset: legacy }, { ...valid, url: 'https://example.test' },
    { ...valid, rate: 1000 }, { ...valid, vus: 50 }, { ...valid, scenario: 'continuity' }]) {
    assert.throws(() => validatePlan(invalid));
  }
});
test('patient group plans enforce identity caps, HTTP presets and duration', () => {
  for (const [preset,limit] of [['cotidiana',25], ['demanda',50], ['atencion',10], ['institucional',1]] as const) {
    const raw = {scenario:'cohort',preset,patients:limit};
    assert.equal(validateExecution(raw).seconds,120);
    assert.throws(()=>validateExecution({...raw,patients:limit+1}));
    assert.throws(()=>validateExecution({...raw,url:'https://example.test'}));
    assert.throws(()=>validateExecution({...raw,seconds:3600}));
  }
});
test('only the exact loopback origin and same-origin context may mutate', () => {
  assert.ok(requestAllowed('127.0.0.1:13400', 'same-origin', 'http://127.0.0.1:13400'));
  assert.ok(!requestAllowed('127.0.0.1:13400', 'same-site', 'http://127.0.0.1:3000'));
  assert.ok(!requestAllowed('example.test', 'same-origin', 'http://127.0.0.1:13400'));
});
test('report whitelist excludes private artifacts and traversal', () => {
  assert.ok(reportFile('k6-phase4-reads-01.json'));
  assert.ok(reportFile('phase5-reference-05.html'));
  assert.ok(reportFile('k6-phase7-sostenida-25.json'));
  assert.ok(!reportFile('phase7-sostenida-25-resources.json'));
  for (const name of ['../simulation.env', 'smoke-token.env', 'phase5-reference-05-timeline.jsonl', 'phase4-a.html/../secret']) assert.ok(!reportFile(name));
});
