#!/usr/bin/env bash
# Installs kube-prometheus-stack (Prometheus + Grafana + Alertmanager) into the
# "monitoring" namespace, then wires the app into it. Idempotent: re-running
# upgrades in place. UIs (via Traefik): http://grafana.local and http://prometheus.local
#
# Files in this directory:
#   values.yaml            - chart config (retention, storage, ingresses, k3s tweaks)
#   servicemonitor.yaml    - makes Prometheus scrape the app's /metrics every 30s
#   alerts.yaml            - PrometheusRule: app down + monitored-host alerts
#   grafana-dashboard.yaml - ConfigMap auto-imported by Grafana as the app dashboard
#
# Note: the app Service (../service.yaml) needs its port named "http" and the
# label app=didactic-dashboard for the ServiceMonitor to find it.
set -euo pipefail

CHART_VERSION="87.10.1" # pinned so the install is reproducible
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update prometheus-community

helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --version "${CHART_VERSION}" \
  -f "${SCRIPT_DIR}/values.yaml"

# Image pulls can take a few minutes on a slow connection
echo "Waiting for monitoring pods to become Ready..."
kubectl wait --for=condition=Ready pods --all -n monitoring --timeout=600s

# App-specific monitoring: scrape config, alert rules and Grafana dashboard.
# Applied after the chart because they use CRDs the chart installs.
kubectl apply -f "${SCRIPT_DIR}/servicemonitor.yaml"
kubectl apply -f "${SCRIPT_DIR}/alerts.yaml"
kubectl apply -f "${SCRIPT_DIR}/grafana-dashboard.yaml"

kubectl get pods -n monitoring
