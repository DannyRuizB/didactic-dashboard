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
  const { ip, name, port } = req.body || {};
  const target = typeof ip === 'string' ? ip.trim() : '';
  if (!isValidTarget(target)) {
    return res.status(400).json({ error: 'Invalid IP or hostname' });
  }
  const parsedPort = parsePort(port);
  if (parsedPort === undefined) {
    return res.status(400).json({ error: 'Invalid port (1-65535)' });
  }
  try {
    const host = db.addHost(
      target,
      typeof name === 'string' && name.trim() ? name.trim() : null,
      parsedPort,
    );
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

// ICMP check using the system `ping` binary (1 packet, 2 s timeout).
function icmpCheck(target) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', target], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, latency: null });
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/);
      resolve({ ok: true, latency: m ? parseFloat(m[1]) : null });
    });
  });
}

// TCP connect check — succeeds if the target accepts a TCP handshake on `port`.
// Useful for VPNs / firewalls that drop ICMP but allow application ports.
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

async function checkAll() {
  const hosts = db.getAllHosts();
  await Promise.all(hosts.map(async (h) => {
    const r = h.port ? await tcpCheck(h.ip, h.port) : await icmpCheck(h.ip);
    db.recordPing(h.id, r.ok, r.latency);
  }));
}

setTimeout(() => {
  checkAll().catch(() => {});
  setInterval(() => checkAll().catch(() => {}), PING_INTERVAL);
}, 2000);

app.listen(PORT, () => {
  console.log(`didactic-dashboard listening on :${PORT} (check every ${PING_INTERVAL}ms)`);
});
