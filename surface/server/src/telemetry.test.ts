import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { installServerTelemetry } from './telemetry.js';

describe('server telemetry', () => {
  it('exports bounded HTTP metrics with route-template labels', async () => {
    const app = Fastify({ logger: false });
    await installServerTelemetry(app);
    app.get('/probe/:id', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/probe/abc' });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    await app.close();

    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain(
      'atrium_http_requests_total{method="GET",route="/probe/:id",status_class="2xx"} 1',
    );
    expect(metrics.body).not.toContain('/probe/abc');
  });
});
