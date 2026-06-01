'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decideMetricTransition, decideStatusTransition } = require('../src/alerts');

// Helper: a classification object as returned by classifyMetric.
const cls = (level) => ({ level, threshold: level === 'critical' ? 90 : 80 });

test('decideMetricTransition: opening and silence', () => {
  // no active alert, no breach -> nothing
  assert.equal(decideMetricTransition(null, null), 'none');
  // no active alert, new breach -> fire
  assert.equal(decideMetricTransition(null, cls('warning')), 'fire');
  assert.equal(decideMetricTransition(null, cls('critical')), 'fire');
  // active alert, same level still breaching -> stay silent (no spam)
  assert.equal(decideMetricTransition('warning', cls('warning')), 'none');
  assert.equal(decideMetricTransition('critical', cls('critical')), 'none');
});

test('decideMetricTransition: level changes rotate', () => {
  // warning escalates to critical
  assert.equal(decideMetricTransition('warning', cls('critical')), 'rotate');
  // critical de-escalates to warning (still a breach, different level)
  assert.equal(decideMetricTransition('critical', cls('warning')), 'rotate');
});

test('decideMetricTransition: clearing', () => {
  // active alert, value back within limits -> resolve
  assert.equal(decideMetricTransition('warning', null), 'resolve');
  assert.equal(decideMetricTransition('critical', null), 'resolve');
});

test('decideStatusTransition: host up resets counter', () => {
  // up with no active DOWN alert -> nothing, counter reset
  assert.deepEqual(
    decideStatusTransition({ isUp: true, downCount: 5, downAfter: 2, hasActiveDownAlert: false }),
    { downCount: 0, action: 'none' },
  );
  // up with an active DOWN alert -> resolve it, counter reset
  assert.deepEqual(
    decideStatusTransition({ isUp: true, downCount: 5, downAfter: 2, hasActiveDownAlert: true }),
    { downCount: 0, action: 'resolve' },
  );
});

test('decideStatusTransition: does not fire on a single blip', () => {
  // first failure, threshold is 2 -> count to 1, no alert yet
  assert.deepEqual(
    decideStatusTransition({ isUp: false, downCount: 0, downAfter: 2, hasActiveDownAlert: false }),
    { downCount: 1, action: 'none' },
  );
});

test('decideStatusTransition: fires once the threshold is reached', () => {
  // second consecutive failure reaches downAfter=2 -> fire
  assert.deepEqual(
    decideStatusTransition({ isUp: false, downCount: 1, downAfter: 2, hasActiveDownAlert: false }),
    { downCount: 2, action: 'fire' },
  );
  // downAfter=1 fires on the very first failure
  assert.deepEqual(
    decideStatusTransition({ isUp: false, downCount: 0, downAfter: 1, hasActiveDownAlert: false }),
    { downCount: 1, action: 'fire' },
  );
});

test('decideStatusTransition: does not re-fire while already alerting', () => {
  // still down, past threshold, but a DOWN alert is already active -> no re-fire
  assert.deepEqual(
    decideStatusTransition({ isUp: false, downCount: 3, downAfter: 2, hasActiveDownAlert: true }),
    { downCount: 4, action: 'none' },
  );
});

test('decideStatusTransition: tolerates missing counter (first ever check)', () => {
  assert.deepEqual(
    decideStatusTransition({ isUp: false, downCount: undefined, downAfter: 2, hasActiveDownAlert: false }),
    { downCount: 1, action: 'none' },
  );
});
