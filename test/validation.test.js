'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidTarget,
  isValidSshUser,
  parseServices,
  parsePort,
  parseThreshold,
  parseThresholdOverrides,
  classifyMetric,
  parseWhoLine,
  metricLabel,
  escapeHtml,
} = require('../src/validation');

test('isValidTarget accepts IPs and hostnames, rejects junk', () => {
  assert.equal(isValidTarget('10.160.218.30'), true);
  assert.equal(isValidTarget('wikijs.practicas.local'), true);
  assert.equal(isValidTarget('host_1-2'), true);
  assert.equal(isValidTarget(''), false);
  assert.equal(isValidTarget('a b'), false);          // space
  assert.equal(isValidTarget('rm;reboot'), false);    // shell metachar
  assert.equal(isValidTarget('x'.repeat(254)), false); // too long
  assert.equal(isValidTarget(42), false);             // not a string
});

test('isValidSshUser enforces charset and length', () => {
  assert.equal(isValidSshUser('danny'), true);
  assert.equal(isValidSshUser('svc_account-1.test'), true);
  assert.equal(isValidSshUser(''), false);
  assert.equal(isValidSshUser('a b'), false);
  assert.equal(isValidSshUser('u'.repeat(33)), false);
  assert.equal(isValidSshUser('root@host'), false);   // @ not allowed
});

test('parsePort: empty -> null, valid -> number, invalid -> undefined', () => {
  assert.equal(parsePort(''), null);
  assert.equal(parsePort(undefined), null);
  assert.equal(parsePort('22'), 22);
  assert.equal(parsePort(443), 443);
  assert.equal(parsePort('0'), undefined);
  assert.equal(parsePort('70000'), undefined);
  assert.equal(parsePort('8.5'), undefined);
  assert.equal(parsePort('abc'), undefined);
});

test('parseThreshold: range, rounding and invalid input', () => {
  assert.equal(parseThreshold(''), null);
  assert.equal(parseThreshold(null), null);
  assert.equal(parseThreshold('80'), 80);
  assert.equal(parseThreshold('79.96'), 80);   // rounds to 1 decimal
  assert.equal(parseThreshold('79.94'), 79.9);
  assert.equal(parseThreshold('0'), 0);
  assert.equal(parseThreshold('100'), 100);
  assert.equal(parseThreshold('-1'), undefined);
  assert.equal(parseThreshold('101'), undefined);
  assert.equal(parseThreshold('NaN'), undefined);
});

test('parseServices: empty, valid list, and rejections', () => {
  assert.deepEqual(parseServices(''), { ok: true, value: null });
  assert.deepEqual(parseServices('nginx, sshd ,docker'), { ok: true, value: 'nginx,sshd,docker' });
  assert.deepEqual(parseServices('  ,  '), { ok: true, value: null }); // only separators
  assert.equal(parseServices('bad name').ok, false);                   // space inside
  assert.equal(parseServices(Array.from({ length: 21 }, () => 'a').join(',')).ok, false); // >20
  assert.equal(parseServices('x'.repeat(65)).ok, false);               // item too long
  assert.equal(parseServices(123).ok, false);                          // not a string
});

test('parseThresholdOverrides: nulls pass, warn>=crit fails, bad value fails', () => {
  const empty = parseThresholdOverrides({});
  assert.equal(empty.ok, true);
  assert.equal(empty.values.cpu_warn, null);

  const good = parseThresholdOverrides({ cpu_warn: '70', cpu_crit: '90' });
  assert.equal(good.ok, true);
  assert.equal(good.values.cpu_warn, 70);
  assert.equal(good.values.cpu_crit, 90);

  const inverted = parseThresholdOverrides({ ram_warn: '95', ram_crit: '80' });
  assert.equal(inverted.ok, false);

  const equal = parseThresholdOverrides({ disk_warn: '80', disk_crit: '80' });
  assert.equal(equal.ok, false);

  const bad = parseThresholdOverrides({ cpu_warn: '150' });
  assert.equal(bad.ok, false);
});

test('classifyMetric: critical/warning/none and missing values', () => {
  const th = { warning: 80, critical: 90 };
  assert.equal(classifyMetric(50, th), null);
  assert.deepEqual(classifyMetric(85, th), { level: 'warning', threshold: 80 });
  assert.deepEqual(classifyMetric(95, th), { level: 'critical', threshold: 90 });
  assert.deepEqual(classifyMetric(80, th), { level: 'warning', threshold: 80 }); // boundary
  assert.deepEqual(classifyMetric(90, th), { level: 'critical', threshold: 90 }); // boundary
  assert.equal(classifyMetric(null, th), null);
  assert.equal(classifyMetric(NaN, th), null);
});

test('parseWhoLine: parses user/tty/from, drops blanks and sshd rows', () => {
  assert.equal(parseWhoLine(''), null);
  assert.equal(parseWhoLine('   '), null);
  assert.deepEqual(
    parseWhoLine('danny    pts/0        2026-06-01 09:00 (10.0.0.5)'),
    { user: 'danny', tty: 'pts/0', from: '10.0.0.5' },
  );
  // local login: no (from) part
  const local = parseWhoLine('root     tty1         2026-06-01 08:00');
  assert.equal(local.user, 'root');
  assert.equal(local.from, 'local');
  // sshd-session row (no real pty) is dropped
  assert.equal(parseWhoLine('danny    sshd         2026-06-01 09:00 (10.0.0.5)'), null);
});

test('metricLabel maps known metrics and passes through unknown', () => {
  assert.equal(metricLabel('cpu'), 'CPU');
  assert.equal(metricLabel('ram'), 'RAM');
  assert.equal(metricLabel('disk'), 'Disk');
  assert.equal(metricLabel('status'), 'host DOWN');
  assert.equal(metricLabel('whatever'), 'whatever');
});

test('escapeHtml escapes the five HTML-sensitive characters', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  assert.equal(escapeHtml('plain'), 'plain');
  assert.equal(escapeHtml(42), '42'); // coerces non-strings
});
