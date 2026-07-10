# Local observability stack

This is the dogfood/local observability target for Atrium + Centaur. It is intentionally
backend-generic at the instrumentation boundary: services emit OpenTelemetry and
Prometheus-compatible metrics; this stack is one self-hostable backend.

## Run

```bash
cd infra/observability
docker compose up -d
```

Open:

- Grafana: <http://127.0.0.1:3000>
- Prometheus: <http://127.0.0.1:9090>
- Alertmanager: <http://127.0.0.1:9093>
- Tempo: <http://127.0.0.1:3200>
- Loki: <http://127.0.0.1:3100>
- Alloy: <http://127.0.0.1:12345>
- OTel Collector OTLP HTTP: <http://127.0.0.1:4318>

## Notes

- Prometheus retention is set to 30 days for dogfood.
- Loki stores data in the named Docker volume `loki_data` and enforces 30-day
  retention (`720h`). The cutover is a fresh start: pre-existing Loki data in the
  old container writable layer is deliberately not migrated and is dropped when the
  container is recreated.
- Grafana Alloy tails local Docker container stdout through the Docker socket and
  writes logs to Loki. Labels are intentionally low-cardinality: `job`, `container`,
  `service`, and `compose_project`; Loki may also derive bounded labels such as
  `service_name` and `detected_level`.
- The collector exposes converted OTLP metrics at `otel-collector:8889`.
- Atrium server exposes Prometheus metrics at `/metrics`. For local trace export,
  run it with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`.
- Centaur `api-rs` is scraped through `host.docker.internal:8080` by default. Adjust
  `prometheus.yml` if your local port differs.
- Centaur `api-rs` exports OTLP traces when its `OTEL_EXPORTER_OTLP_ENDPOINT` or
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` points at a collector reachable from its
  runtime environment.
- Local Docker logs are available in Grafana through the `Docker logs` dashboard
  panel or with Loki queries such as `{job="docker"}`.
- Alloy drops Docker log backfill older than one hour and rate-limits initial bursts so
  a noisy local daemon does not overwhelm Loki on first startup.
- Alerts route to `http://host.docker.internal:3209/alerts` as an external fallback.
  Replace that receiver with email/pager config for dogfood, or run a tiny local
  webhook relay while developing.

## Centaur Kubernetes logs

Local Docker log shipping only sees containers visible to the host Docker daemon.
Centaur usually runs in Kubernetes, so its pod logs need an in-cluster collector. Use
`centaur-alloy-values.yaml` with the Grafana Alloy Helm chart as the starting point for
dogfood clusters; it keeps labels bounded to `job`, `namespace`, `pod`, `container`,
and `app`.

Apply the in-cluster Loki Service/Endpoints bridge after the stack is listening on
the host's k3s bridge address:

```bash
kubectl apply -f infra/observability/k8s/loki-service.yaml
```

This makes `loki.observability.svc.cluster.local:3100` resolve to the host Loki
listener at `10.42.0.1:3100` for the k3s-side Alloy deployment.

## Boot self-heal

`deploy/boot-heal.service` is a box-specific systemd oneshot that runs
`docker compose up -d` for the Surface production stack and this observability
stack after Docker and networking are online. It heals boot-time Docker restore
drift such as missing network endpoints, aliases, port publishes, or skipped
containers; restart policies cannot detect that class of failure.

Install it on the box as root:

```bash
sudo deploy/install-boot-heal.sh
```
