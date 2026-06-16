import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

export interface ChaosRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

export interface ChaosResponse {
  statusCode: number;
  body: unknown;
}

export class SeededPrng {
  constructor(private state: number) {
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  next(): number {
    let x = this.state | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

export function chaosSeed(): number {
  const raw = process.env.CHAOS_SEED;
  if (raw != null && /^\d+$/.test(raw)) return Number(raw) >>> 0;
  return 0xb501d00d;
}

export async function chaosInject(
  app: FastifyInstance,
  request: ChaosRequest,
  rng: SeededPrng,
): Promise<ChaosResponse[]> {
  const send = async (extraDelay = 0): Promise<ChaosResponse> => {
    if (extraDelay > 0) await delay(extraDelay);
    const res = await app.inject({
      method: request.method,
      url: request.url,
      headers: request.headers,
      payload: request.payload,
    } as any);
    return { statusCode: res.statusCode, body: parseBody(res.body) };
  };

  switch (rng.int(4)) {
    case 0:
      return [await send(), await send()];
    case 1:
      return Promise.all([send(rng.int(25)), send(rng.int(25))]);
    case 2: {
      const dropped = await send();
      const retry = await send(rng.int(20));
      return [dropped, retry];
    }
    default:
      return Promise.all([send(rng.int(40)), send(rng.int(10)), send(rng.int(25))]);
  }
}

export class ChaosCentaur {
  private server: Server;
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly answers: unknown[] = [];
  url = '';
  private executions = 0;

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fake centaur did not bind tcp');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
        else resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, body });
    const sessionMatch = /^\/api\/session\/([^/]+)(?:\/(messages|execute|events|cancel))?$/.exec(url.pathname);
    if (sessionMatch) {
      const threadKey = decodeURIComponent(sessionMatch[1]!);
      const action = sessionMatch[2] ?? '';
      if (req.method === 'POST' && action === '') {
        this.requests.push({
          method: 'POST',
          path: '/agent/spawn',
          body: { thread_key: threadKey, harness: body.harness_type },
        });
        return sendJson(res, { thread_key: threadKey, assignment_generation: 1 });
      }
      if (req.method === 'POST' && action === 'messages') {
        this.requests.push({ method: 'POST', path: '/agent/message', body });
        return sendJson(res, {});
      }
      if (req.method === 'POST' && action === 'execute') {
        this.executions += 1;
        this.requests.push({ method: 'POST', path: '/agent/execute', body });
        return sendJson(res, { execution_id: `exe_chaos_${this.executions}` });
      }
      if (req.method === 'GET' && action === 'events') {
        this.requests.push({ method: 'GET', path: `/agent/threads/${threadKey}/events`, body: {} });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end();
        return;
      }
      if (req.method === 'POST' && action === 'cancel') {
        this.requests.push({ method: 'POST', path: `/api/session/${threadKey}/cancel`, body });
        return sendJson(res, { ok: true, cancelled: true, execution_id: `exe_chaos_${this.executions}` });
      }
    }
    if (req.method === 'POST' && url.pathname === '/agent/spawn') {
      return sendJson(res, { thread_key: body.thread_key, assignment_generation: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/agent/message') {
      return sendJson(res, {});
    }
    if (req.method === 'POST' && url.pathname === '/agent/execute') {
      this.executions += 1;
      return sendJson(res, { execution_id: `exe_chaos_${this.executions}` });
    }
    if (req.method === 'POST' && /^\/agent\/executions\/[^/]+\/answer$/.test(url.pathname)) {
      this.answers.push(body);
      return sendJson(res, {});
    }
    if (req.method === 'POST' && url.pathname.endsWith('/release')) {
      return sendJson(res, {});
    }
    if (req.method === 'GET' && /\/agent\/threads\/[^/]+\/events/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  }
}

function parseBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, body: object, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
