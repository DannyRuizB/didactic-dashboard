# didactic-dashboard

Simple self-hosted monitoring dashboard. Add a host by IP and watch CPU, RAM, disk, services and alerts in real time. Docker-ready, built for learning.

> Work in progress — v0.1 coming soon.

## Features (planned)

- Add any Linux host by IP from the web UI
- Real-time metrics: CPU, RAM, disk, load, uptime
- Service status (systemd)
- Top processes and active connections
- Historical data (1h / 24h / 7d / 30d) stored in SQLite
- Alerts (warning / critical) for CPU, RAM, disk and downed services
- One-command deploy with Docker Compose

## Why

A lightweight, didactic alternative to Zabbix — simple enough to read, modify and learn from. Great for home labs and small sysadmin practice environments.

## Tech stack

- Node.js + Express (backend)
- SQLite (storage)
- Vanilla HTML / CSS / JS (frontend)
- Docker + Docker Compose (deploy)

## Roadmap

- [ ] v0.1 — Add/remove hosts via UI, ping + basic metrics, Docker Compose
- [ ] v0.2 — SSH-based detailed metrics (CPU, RAM, disk, services)
- [ ] v0.3 — History charts and alerts
- [ ] v0.4 — Auto-discovery on local network

## License

MIT — see [LICENSE](LICENSE)

## Author

Danny Ruiz — [github.com/DannyRuizB](https://github.com/DannyRuizB)
