# Observability strategy

Atrium and Centaur should be observable through generic, self-hostable primitives. The
contract is OpenTelemetry, Prometheus-compatible metrics, structured JSON logs, and
the durable Atrium session record. Grafana/Loki/Tempo/Prometheus is the first
dogfood backend, but service instrumentation must not depend on that backend.

## Goals

- Debug dogfood/staging failures across Atrium, Centaur, and harnesses.
- Preserve a single correlation path for one session run.
- Keep operational telemetry short-lived and content-safe by default.
- Keep rich agent/debug content in Atrium's durable, access-controlled session plane.
- Leave product analytics as a separate later layer.

## Data planes

| Plane | Contents | Retention | Access |
| --- | --- | --- | --- |
| Operational telemetry | logs, metrics, traces, runtime errors, request spans, worker state | 14-30 days in dogfood | operators |
| Durable session record | `session_events`, artifacts, transcript/debug events, usage/cost | product policy | Atrium auth |
| Product analytics | funnels, activation, retention, feature usage | later policy | analytics/admin |

Operational telemetry may point at durable session records. It must not duplicate rich
session content.

## Canonical fields

Use these field names consistently in logs and spans when known:

- `workspace_id`
- `channel_id`
- `session_id`
- `centaur_thread_key`
- `execution_id`
- `entry_uid`
- `trace_id`
- `span_id`
- `capture_mode`
- `component`
- `event`

Metric labels must stay finite and low-cardinality. Good labels: `method`, `route`,
`status_class`, `worker`, `operation`, `status`, `harness`, `backend`, `result`.

Never use `workspace_id`, `channel_id`, `session_id`, `centaur_thread_key`,
`execution_id`, `entry_uid`, `user_id`, or raw error messages as metric labels.

## Forbidden operational payloads

Do not put these in operational logs, metric labels, or trace attributes:

- prompts or message text
- raw model output
- sandbox stdout/stderr lines
- tool arguments or tool results
- command output
- file contents
- auth headers, API keys, cookies, session tokens
- environment variable values
- unbounded metadata blobs

Use error classes, status codes, byte counts, token counts, sizes, route templates, and
stable IDs instead.

## Admin verbose mode

Admin verbose capture is for dogfood debugging. It is eligibility-gated by admin user,
but should be enabled per session or per run when practical.

- `capture_mode = "standard"` by default.
- `capture_mode = "admin_verbose"` for eligible debug runs.
- Rich payloads are written to the durable session plane as explicit debug events or
  artifacts with an expiry/retention policy.
- Operational telemetry records only references such as `session_id`, `execution_id`,
  `entry_uid`, `capture_mode`, and event class.
- Verbose runs should force 100% trace sampling while still keeping content out of
  traces.

## Trace shape

Atrium should create spans around:

- inbound HTTP requests
- WebSocket lifecycle work
- Centaur `spawn`, `message`, `execute`, `events`, `answer`, `cancel`, `release`
- session mirroring/folding
- background workers

Atrium should propagate W3C `traceparent` to Centaur calls. Centaur should extract the
incoming context for its HTTP request spans while preserving its deterministic
per-thread trace root for harness/session continuity.

The target debugging path is:

```text
browser/client -> Atrium server -> Centaur api-rs -> sandbox/harness
```

## Dogfood backend

The first self-hostable stack is:

- OpenTelemetry Collector for OTLP ingestion/routing
- Prometheus or VictoriaMetrics for metrics
- Tempo for traces
- Grafana for dashboards and alerts
- Loki for logs after JSON log shipping is wired

Alerts must have an external fallback path first. Atrium-native ops inbox mirroring can
come later, but it must not be the only alert destination.

## Rollout

1. Land this strategy and local stack config.
2. Instrument Atrium server with structured logs, metrics, and traces.
3. Propagate and extract trace context across Atrium/Centaur.
4. Add admin verbose durable debug events.
5. Add dashboards.
6. Add alert fallback, then Atrium ops mirroring.
7. Add client error telemetry.
8. Add product analytics and governance separately.
