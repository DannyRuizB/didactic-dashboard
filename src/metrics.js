'use strict';

// Prometheus instrumentation, extracted from server.js as a factory so it can
// be unit-tested without a server or a database: tests inject plain functions
// returning fixture rows instead of db.listHosts / db.listActiveAlerts. Each
// call builds its own Registry (registers: [register], never the global one),
// so tests get isolated, collision-free instances.
//
// The three state gauges are recomputed inside collect(), which prom-client
// runs at scrape time — SQLite is the source of truth, so instead of
// sprinkling inc/dec calls across the add/delete/adopt/resolve paths we just
// re-read it on every scrape. Deleted hosts and cleared alerts drop off on
// the very next scrape, no stale series. better-sqlite3 is synchronous, so
// collect() can be a plain function.

const client = require('prom-client');

function createMetrics(listHosts, listActiveAlerts) {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  new client.Gauge({
    name: 'didactic_monitored_hosts',
    help: 'Hosts currently registered, by check type',
    labelNames: ['check_type'],
    registers: [register],
    collect() {
      this.reset();
      for (const h of listHosts()) this.inc({ check_type: h.check_type });
    },
  });

  new client.Gauge({
    name: 'didactic_host_up',
    help: 'Result of the last probe per host (1 = up, 0 = down)',
    labelNames: ['host', 'check_type'],
    registers: [register],
    collect() {
      this.reset();
      for (const h of listHosts()) {
        // last_ok is null until the first probe runs — skip those hosts
        // rather than reporting a false "down".
        if (h.last_ok == null) continue;
        this.set({ host: h.name || h.ip, check_type: h.check_type }, h.last_ok);
      }
    },
  });

  const probeDuration = new client.Histogram({
    name: 'didactic_probe_duration_seconds',
    help: 'Wall-clock duration of host probes',
    labelNames: ['check_type', 'result'],
    // Matches the probes' timeout range (2 s ping to 15 s discovery-grade SSH).
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
    registers: [register],
  });

  const alertsFired = new client.Counter({
    name: 'didactic_alerts_fired_total',
    help: 'Alerts fired since process start, by metric and level',
    labelNames: ['metric', 'level'],
    registers: [register],
  });

  new client.Gauge({
    name: 'didactic_active_alerts',
    help: 'Currently firing alerts, by metric and level',
    labelNames: ['metric', 'level'],
    registers: [register],
    collect() {
      this.reset();
      for (const a of listActiveAlerts()) this.inc({ metric: a.metric, level: a.level });
    },
  });

  return { register, probeDuration, alertsFired };
}

module.exports = { createMetrics };
