const express = require('express');
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

app.get('/api/hosts', (_req, res) => {
  res.json(db.listHosts());
});

app.post('/api/hosts', (req, res) => {
  const { ip, name } = req.body || {};
  const target = typeof ip === 'string' ? ip.trim() : '';
  if (!isValidTarget(target)) {
    return res.status(400).json({ error: 'Invalid IP or hostname' });
  }
  try {
    const host = db.addHost(target, typeof name === 'string' && name.trim() ? name.trim() : null);
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

function pingOnce(target) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', target], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, latency: null });
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/);
      resolve({ ok: true, latency: m ? parseFloat(m[1]) : null });
    });
  });
}

async function pingAll() {
  const hosts = db.getAllHostIds();
  await Promise.all(hosts.map(async (h) => {
    const r = await pingOnce(h.ip);
    db.recordPing(h.id, r.ok, r.latency);
  }));
}

setTimeout(() => {
  pingAll().catch(() => {});
  setInterval(() => pingAll().catch(() => {}), PING_INTERVAL);
}, 2000);

app.listen(PORT, () => {
  console.log(`didactic-dashboard listening on :${PORT} (ping every ${PING_INTERVAL}ms)`);
});
