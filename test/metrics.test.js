'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMetrics } = require('../src/metrics');

// Fixture rows shaped like db.listHosts() output (only the fields the
// gauges read) and db.listActiveAlerts() output.
const HOSTS = [
  { name: 'web', ip: '10.0.0.1', check_type: 'icmp', last_ok: 1 },
  { name: null, ip: '10.0.0.2', check_type: 'ssh', last_ok: 0 },
  { name: 'new', ip: '10.0.0.3', check_type: 'tcp', last_ok: null },
];

test('host gauges are recomputed from listHosts at scrape time', async () => {
  const m = createMetrics(() => HOSTS, () => []);
  const text = await m.register.metrics();
  assert.match(text, /didactic_monitored_hosts\{check_type="icmp"\} 1/);
  assert.match(text, /didactic_monitored_hosts\{check_type="ssh"\} 1/);
  assert.match(text, /didactic_monitored_hosts\{check_type="tcp"\} 1/);
  assert.match(text, /didactic_host_up\{host="web",check_type="icmp"\} 1/);
  // falls back to the ip when the host has no name
  assert.match(text, /didactic_host_up\{host="10\.0\.0\.2",check_type="ssh"\} 0/);
  // never-probed host (last_ok null) emits no up/down series
  assert.doesNotMatch(text, /didactic_host_up\{host="new"/);
});

test('deleted hosts vanish on the next scrape', async () => {
  let hosts = HOSTS;
  const m = createMetrics(() => hosts, () => []);
  assert.match(await m.register.metrics(), /host="web"/);
  hosts = HOSTS.slice(1);
  const text = await m.register.metrics();
  assert.doesNotMatch(text, /host="web"/);
  assert.doesNotMatch(text, /didactic_monitored_hosts\{check_type="icmp"\} 1/);
});

test('probe histogram and alert counter record observations', async () => {
  const m = createMetrics(() => [], () => []);
  m.probeDuration.observe({ check_type: 'icmp', result: 'success' }, 0.05);
  m.alertsFired.inc({ metric: 'cpu', level: 'critical' });
  const text = await m.register.metrics();
  assert.match(text, /didactic_probe_duration_seconds_count\{check_type="icmp",result="success"\} 1/);
  assert.match(text, /didactic_alerts_fired_total\{metric="cpu",level="critical"\} 1/);
});

test('active alerts gauge groups by metric and level', async () => {
  const m = createMetrics(() => [], () => [
    { metric: 'cpu', level: 'critical' },
    { metric: 'cpu', level: 'critical' },
    { metric: 'status', level: 'critical' },
  ]);
  const text = await m.register.metrics();
  assert.match(text, /didactic_active_alerts\{metric="cpu",level="critical"\} 2/);
  assert.match(text, /didactic_active_alerts\{metric="status",level="critical"\} 1/);
});

test('default process metrics are present', async () => {
  const m = createMetrics(() => [], () => []);
  const text = await m.register.metrics();
  assert.match(text, /process_cpu_seconds_total/);
});

// End-to-end: spawn the real server (it can't be require()d — it starts the
// scheduler and listens at load time) and scrape GET /metrics over HTTP.
test('GET /metrics serves the exposition format', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'didactic-metrics-'));
  const port = 3900 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(dir, 'test.db'),
      PING_INTERVAL: '60000',
    },
    stdio: 'ignore',
  });
  try {
    let res = null;
    for (let i = 0; i < 50 && !res; i++) {
      res = await fetch(`http://127.0.0.1:${port}/metrics`)
        .catch(() => new Promise((r) => setTimeout(() => r(null), 100)));
    }
    assert.ok(res, 'server did not come up');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    const body = await res.text();
    assert.match(body, /process_cpu_seconds_total/);
    assert.match(body, /didactic_monitored_hosts/);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
