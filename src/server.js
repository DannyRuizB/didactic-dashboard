const express = require('express');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');

const PORT          = parseInt(process.env.PORT          || '3000',  10);
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL || '10000', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isValidTarget(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length > 253) return false;
  return /^[a-zA-Z0-9.\-_]+$/.test(str);
}

function isValidSshUser(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length > 32) return false;
  return /^[a-zA-Z0-9._-]+$/.test(str);
}

function parsePort(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

app.get('/api/hosts', (_req, res) => {
  res.json(db.listHosts());
});

app.post('/api/hosts', (req, res) => {
  const body = req.body || {};
  const target = typeof body.ip === 'string' ? body.ip.trim() : '';
  if (!isValidTarget(target)) {
    return res.status(400).json({ error: 'Invalid IP or hostname' });
  }

  const type = ['icmp', 'tcp', 'ssh'].includes(body.check_type) ? body.check_type : 'icmp';

  let parsedPort = parsePort(body.port);
  if (parsedPort === undefined) {
    return res.status(400).json({ error: 'Invalid port (1-65535)' });
  }
  if (type === 'tcp' && !parsedPort) {
    return res.status(400).json({ error: 'Port is required for TCP check' });
  }
  if (type === 'ssh' && !parsedPort) parsedPort = 22;
  if (type === 'icmp') parsedPort = null;

  let user = null;
  if (type === 'ssh') {
    const u = typeof body.ssh_user === 'string' ? body.ssh_user.trim() : '';
    if (!isValidSshUser(u)) {
      return res.status(400).json({ error: 'Valid SSH user required (letters, digits, . _ -)' });
    }
    user = u;
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;

  try {
    const host = db.addHost(target, name, parsedPort, type, user);
    res.status(201).json(host);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Host already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/hosts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  db.deleteHost(id);
  res.status(204).end();
});

// ICMP check via the system `ping` binary (1 packet, 2 s timeout).
function icmpCheck(target) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', target], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, latency: null });
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/);
      resolve({ ok: true, latency: m ? parseFloat(m[1]) : null });
    });
  });
}

// TCP connect check — useful when ICMP is blocked (VPNs, firewalls).
function tcpCheck(target, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, latency: ok ? Date.now() - start : null });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error',   () => finish(false));
    socket.connect(port, target);
  });
}

// Single remote command that prints key=value metrics, newline-separated.
// Simple primitives only — no package installs required on the target host.
const REMOTE_SCRIPT = [
  "top -bn1 | awk '/%Cpu/{print \"cpu=\"$2}'",
  "free | awk '/^Mem:/{printf \"ram=%.1f\\n\", $3/$2*100}'",
  "df / | awk 'END{sub(/%/,\"\",$5); print \"disk=\"$5}'",
  "awk '{printf \"load=%.2f\\n\",$1}' /proc/loadavg",
  "awk '{printf \"uptime=%d\\n\",$1}' /proc/uptime",
].join(';');

function sshCheck(target, user, port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(port || 22),
      `${user}@${target}`,
      REMOTE_SCRIPT,
    ];
    execFile('ssh', args, { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, latency: null, metrics: null });
      const latency = Date.now() - start;
      const parsed = {};
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(\w+)=([\d.]+)/);
        if (m) parsed[m[1]] = parseFloat(m[2]);
      }
      const required = ['cpu', 'ram', 'disk', 'load', 'uptime'];
      for (const k of required) if (!(k in parsed)) {
        return resolve({ ok: true, latency, metrics: null });
      }
      resolve({
        ok: true,
        latency,
        metrics: {
          cpu: parsed.cpu,
          ram: parsed.ram,
          disk: parsed.disk,
          load1: parsed.load,
          uptime_s: Math.round(parsed.uptime),
        },
      });
    });
  });
}

async function checkAll() {
  const hosts = db.getAllHosts();
  await Promise.all(hosts.map(async (h) => {
    let result;
    if (h.check_type === 'ssh') {
      result = await sshCheck(h.ip, h.ssh_user, h.port);
      db.recordPing(h.id, result.ok, result.latency);
      if (result.metrics) db.recordMetrics(h.id, result.metrics);
    } else if (h.check_type === 'tcp' && h.port) {
      result = await tcpCheck(h.ip, h.port);
      db.recordPing(h.id, result.ok, result.latency);
    } else {
      result = await icmpCheck(h.ip);
      db.recordPing(h.id, result.ok, result.latency);
    }
  }));
}

setTimeout(() => {
  checkAll().catch(() => {});
  setInterval(() => checkAll().catch(() => {}), PING_INTERVAL);
}, 2000);

app.listen(PORT, () => {
  console.log(`didactic-dashboard listening on :${PORT} (check every ${PING_INTERVAL}ms)`);
});
