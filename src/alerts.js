'use strict';

// Pure decision helpers for the alert engine, extracted from server.js's
// evaluateAlerts() so the state-machine logic can be unit-tested without a
// database, webhooks, email or the in-memory down-counter. server.js keeps
// the side effects (db reads/writes, firing/resolving) and delegates the
// "what should happen now?" decision to these functions.

// Decide the transition for a single metric (cpu/ram/disk), given the level of
// the currently active alert (or null) and the new classification from
// classifyMetric (or null). Returns one of:
//   'fire'    — no active alert and a new breach: open one
//   'resolve' — an alert was active and the value is back within limits: close
//   'rotate'  — active alert but the level changed (warning <-> critical):
//               close the old one and open a new one
//   'none'    — nothing to do (no breach and none active, or same level still
//               breaching: stay silent, no webhook/email spam)
function decideMetricTransition(activeLevel, newClass) {
  const newLevel = newClass ? newClass.level : null;
  if (newLevel) {
    if (!activeLevel) return 'fire';
    if (activeLevel !== newLevel) return 'rotate';
    return 'none';
  }
  return activeLevel ? 'resolve' : 'none';
}

// Decide the host-status (UP/DOWN) transition. Pure: takes the current state
// and returns the next value of the down-counter plus the action to take.
//   - host is up:   reset the counter; if a DOWN alert is active -> 'resolve'
//   - host is down: increment the counter; fire only once it reaches
//                   downAfter consecutive failures and no DOWN alert is active
//                   yet -> 'fire' (avoids alerting on a single transient blip)
function decideStatusTransition({ isUp, downCount, downAfter, hasActiveDownAlert }) {
  if (isUp) {
    return { downCount: 0, action: hasActiveDownAlert ? 'resolve' : 'none' };
  }
  const next = (downCount || 0) + 1;
  if (next >= downAfter && !hasActiveDownAlert) {
    return { downCount: next, action: 'fire' };
  }
  return { downCount: next, action: 'none' };
}

module.exports = {
  decideMetricTransition,
  decideStatusTransition,
};
