# Monitoring — kube-prometheus-stack

Full observability for the app on the same cluster as [Option C](../../../README.md#option-c--kubernetes). The pipeline, in words:

**kube-prometheus-stack** (Helm chart, pinned: Prometheus + Grafana + Alertmanager + node-exporter + kube-state-metrics) → **ServiceMonitor** (scrapes the app's [`/metrics`](../../../README.md#metrics-prometheus) every 30s) → **PrometheusRule** (three starter alerts) → **Grafana dashboard** (provisioned from a ConfigMap, no clicking around).

## Prerequisites

- The app deployed with the Option C manifests (`kubectl apply -f deploy/k8s/`) — the ServiceMonitor finds the app Service by its `app: didactic-dashboard` label and named `http` port.
- `helm` (v3) and `kubectl` pointed at the cluster.
- Roughly **2 GB of RAM** to spare on the node: the stack requests ~1 GB and Prometheus is the hungriest piece.

## Usage

```bash
./install.sh
```

Idempotent: re-running upgrades the release in place. It installs the chart (pinned version, see `CHART_VERSION` in the script), waits for the pods, then applies the three app-specific manifests — those go last because they use CRDs the chart installs.

The UIs answer through the Traefik ingress on two hosts — map them in `/etc/hosts` next to `dashboard.local`:

| UI           | URL                     | Credentials                          |
|--------------|-------------------------|--------------------------------------|
| Grafana      | http://grafana.local    | `admin` / `didactic-grafana`         |
| Prometheus   | http://prometheus.local | none                                 |

The app dashboard shows up in Grafana as **didactic-dashboard** (auto-imported). In Prometheus, *Status → Targets* should list the `didactic-dashboard` job as UP, and the *Alerts* tab shows the three rules below.

## Files

| File                     | What it is                                                              |
|--------------------------|-------------------------------------------------------------------------|
| `install.sh`             | Helm install/upgrade of the pinned chart + `kubectl apply` of the rest  |
| `values.yaml`            | Chart config: retention, storage, ingresses, resource limits, k3s tweaks|
| `servicemonitor.yaml`    | Tells Prometheus to scrape the app's `/metrics` across namespaces       |
| `alerts.yaml`            | PrometheusRule with the three app alerts                                |
| `grafana-dashboard.yaml` | ConfigMap that Grafana's sidecar auto-imports as the app dashboard      |

## Alerts

| Alert               | Fires when                                            | For  | Severity |
|---------------------|-------------------------------------------------------|------|----------|
| `DashboardDown`     | The scrape target is down — or gone entirely (`absent()`) | 2m   | critical |
| `MonitoredHostDown` | The app's own probes report a watched host as down (`didactic_host_up == 0`) | 5m | warning |
| `NoHostsMonitored`  | The app runs but watches zero hosts (empty/reset DB?) | 10m  | warning  |

Alertmanager is enabled but routes everything to the `null` receiver: alerts are visible in the UIs, sent nowhere. Wire a real receiver in `values.yaml` (`alertmanager.config`) if you want email/Slack — the app also has its own [webhook/email alerting](../../../README.md#alerts) independent of Prometheus.

## Design decisions

- **Chart version pinned** (`CHART_VERSION` in `install.sh`) for the same reason the AWS deploy pins its hardening roles: upgrades should be deliberate, not a side effect of re-running the script.
- **k3s control-plane scrapers disabled** (`kubeEtcd`, `kubeControllerManager`, `kubeScheduler`, `kubeProxy`): in k3s those components live inside the k3s process and don't expose the endpoints the chart expects — leaving them on just produces permanently-down targets and false alerts.
- **node-exporter without the host-rootfs mount**: on WSL2 `/` is not a shared mount and the default configuration crash-loops with `CreateContainerError`. Root-filesystem metrics are the only loss.
- **Grafana on `Recreate`**: same story as the app itself — a single ReadWriteOnce volume deadlocks RollingUpdate during upgrades.
- **7 days of retention, 2 Gi of storage**: a week of history is plenty for a lab and keeps the PVC small.
- **Plaintext Grafana password in `values.yaml`**: local lab only. In anything shared, use `grafana.admin.existingSecret` instead.
