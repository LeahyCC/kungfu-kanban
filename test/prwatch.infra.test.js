const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeChecks, trackChecks, infraFromJobs, probeInfra } = require('../lib/prwatch');
const errlog = require('../lib/errlog');

function fakeTask(overrides = {}) {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    title: 'Fake card',
    status: 'review',
    prUrl: 'https://github.com/x/y/pull/1',
    ...overrides,
  };
}

// --- infraFromJobs: the account-block signature is "failed without a runner" ---

test('infraFromJobs: all failed jobs never started → account-level block', () => {
  assert.equal(infraFromJobs([
    { conclusion: 'failure', runner_id: 0, steps: [] },
    { conclusion: 'failure', runner_id: 0, steps: [] },
  ]), true);
});

test('infraFromJobs: a failed job that actually ran steps is a CODE failure', () => {
  assert.equal(infraFromJobs([
    { conclusion: 'failure', runner_id: 12, steps: [{ name: 'checkout' }] },
    { conclusion: 'failure', runner_id: 0, steps: [] },
  ]), false);
});

test('infraFromJobs: no failed jobs (or no jobs at all) is not a block', () => {
  assert.equal(infraFromJobs([{ conclusion: 'success', runner_id: 5, steps: [{}] }]), false);
  assert.equal(infraFromJobs([]), false);
  assert.equal(infraFromJobs(null), false);
});

test('infraFromJobs: missing runner_id/steps fields read as never-started', () => {
  assert.equal(infraFromJobs([{ conclusion: 'failure' }]), true);
});

// --- summarizeChecks carries the failing Actions URL for the probe ---

test('summarizeChecks: failedUrl is the FIRST failing check\'s detailsUrl, absent when green', () => {
  const out = summarizeChecks([
    { __typename: 'CheckRun', name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/x/y/actions/runs/1/job/10' },
    { __typename: 'CheckRun', name: 'bad1', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/x/y/actions/runs/2/job/20' },
    { __typename: 'CheckRun', name: 'bad2', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/x/y/actions/runs/3/job/30' },
  ]);
  assert.equal(out.failedUrl, 'https://github.com/x/y/actions/runs/2/job/20');
  assert.equal('failedUrl' in summarizeChecks([]), false);
});

// --- trackChecks: the verified infra verdict survives churn while red, dies on green ---

test('trackChecks: infra verdict carries across a red-state key change and clears on green', () => {
  const t = fakeTask();
  try {
    const red = (extra = []) => ({
      baseRefName: 'main',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/x/y/actions/runs/9/job/1' },
        ...extra,
      ],
    });
    trackChecks(t, red());
    t.prChecks.infra = true; // what probeInfra stamps
    t.prChecks.infraNote = 'spending limit';
    t.ciInfraNotified = true;

    // a green check completing around the red one changes the key but not the verdict
    trackChecks(t, red([{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }]));
    assert.equal(t.prChecks.infra, true);
    assert.equal(t.prChecks.infraNote, 'spending limit');

    // full recovery drops the verdict and re-arms the once-per-spell notification
    trackChecks(t, {
      baseRefName: 'main',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    assert.equal(t.prChecks.infra, undefined);
    assert.equal(t.ciInfraNotified, null);
  } finally {
    errlog.resolveTask(t.id);
  }
});

// --- probeInfra gates: never probes when there is nothing decisive to learn ---

test('probeInfra: no-ops on pending, green, or already-verdicted checks', async () => {
  // pending → wait; verdict already stamped → keep it; failing 0 → nothing to explain.
  for (const prChecks of [
    { failing: 1, pending: 2 },
    { failing: 1, pending: 0, infra: false },
    { failing: 0, pending: 0 },
    undefined,
  ]) {
    const t = fakeTask({ prChecks });
    await probeInfra(t); // would throw/hang on a real gh call — the gate returns first
    if (prChecks) assert.deepEqual(t.prChecks, prChecks);
  }
});

test('probeInfra: a non-Actions failure (no run URL) is marked not-infra without a gh call', async () => {
  const t = fakeTask({ prChecks: { failing: 1, pending: 0, failedUrl: 'https://jenkins.example.com/build/7' } });
  await probeInfra(t);
  assert.equal(t.prChecks.infra, false);
});
