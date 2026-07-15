import { context, propagation } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import client from 'prom-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

let sdk: NodeSDK | null = null;
let started = false;

export async function initServerTelemetry(): Promise<void> {
  if (started) return;
  started = true;

  client.collectDefaultMetrics({
    prefix: 'atrium_',
  });

  if (process.env.ATRIUM_OTEL === '0') return;

  const hasOtlpEndpoint = Boolean(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  );
  if (!hasOtlpEndpoint && !['otlp'].includes((process.env.OTEL_TRACES_EXPORTER ?? '').toLowerCase())) {
    return;
  }

  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'atrium-server',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation()],
  });
  await sdk.start();
}

export async function shutdownServerTelemetry(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  await current.shutdown();
}

export function currentTraceHeaders(): Record<string, string | undefined> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
}

const httpRequests = new client.Counter({
  name: 'atrium_http_requests_total',
  help: 'HTTP requests served by the Atrium server.',
  labelNames: ['method', 'route', 'status_class'] as const,
});

const httpDuration = new client.Histogram({
  name: 'atrium_http_request_duration_seconds',
  help: 'HTTP request latency in seconds for the Atrium server.',
  labelNames: ['method', 'route', 'status_class'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const httpInflight = new client.Gauge({
  name: 'atrium_http_requests_in_flight',
  help: 'Current in-flight HTTP requests in the Atrium server.',
});

const rateLimited = new client.Counter({
  name: 'atrium_rate_limited_total',
  help: 'Requests rejected by the Atrium server rate limiter.',
  labelNames: ['route'] as const,
});

export function recordRateLimited(route: string): void {
  rateLimited.inc({ route });
}

const requestStarts = new WeakMap<FastifyRequest, bigint>();

export async function installServerTelemetry(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    if (req.url === '/metrics') return;
    requestStarts.set(req, process.hrtime.bigint());
    httpInflight.inc();
  });

  app.addHook('onResponse', async (req, reply) => {
    recordHttpRequest(req, reply);
  });

  app.addHook('onError', async (req, reply) => {
    recordHttpRequest(req, reply);
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', client.register.contentType);
    return client.register.metrics();
  });
}

function recordHttpRequest(req: FastifyRequest, reply: FastifyReply): void {
  const start = requestStarts.get(req);
  if (!start) return;
  requestStarts.delete(req);
  httpInflight.dec();

  const route = metricRoute(req);
  const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
  const labels = {
    method: req.method,
    route,
    status_class: statusClass,
  };
  httpRequests.inc(labels);
  httpDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
}

function metricRoute(req: FastifyRequest): string {
  const route = req.routeOptions?.url;
  if (typeof route === 'string' && route.length > 0) return route;
  return 'unmatched';
}
