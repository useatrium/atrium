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
- Tempo: <http://127.0.0.1:3200>
- Loki: <http://127.0.0.1:3100>
- OTel Collector OTLP HTTP: <http://127.0.0.1:4318>

## Notes

- Prometheus retention is set to 30 days for dogfood.
- The collector exposes converted OTLP metrics at `otel-collector:8889`.
- Centaur `api-rs` is scraped through `host.docker.internal:8080` by default. Adjust
  `prometheus.yml` if your local port differs.
- Log routing to Loki is intentionally minimal until Atrium/Centaur JSON log shipping is
  wired.
