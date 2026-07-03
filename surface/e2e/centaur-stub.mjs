import http from 'node:http';

const port = Number(process.env.PORT ?? 18100);
const requests = [];

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.byteLength),
  });
  res.end(bytes);
}

function sse(res, body) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/__requests') {
    return json(res, 200, requests);
  }
  if (req.method === 'DELETE' && url.pathname === '/__requests') {
    requests.length = 0;
    return json(res, 200, { ok: true });
  }

  const body = await readBody(req);
  requests.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, body });

  if (req.method === 'GET' && /\/api\/session\/[^/]+\/events$/.test(url.pathname)) {
    const after = Number(url.searchParams.get('after_event_id') ?? 0);
    const eventId = Number.isFinite(after) ? after + 1 : 1;
    return sse(
      res,
      `event: session.execution_completed\nid: ${eventId}\ndata: ${JSON.stringify({
        event_id: eventId,
        status: 'completed',
        result_text: 'e2e centaur stub completed',
      })}\n\n`,
    );
  }

  if (req.method === 'POST' && /\/api\/session\/[^/]+\/execute$/.test(url.pathname)) {
    return json(res, 200, { execution_id: `exe_stub_${Date.now().toString(36)}` });
  }
  if (req.method === 'POST' && /^\/api\/session\/[^/]+$/.test(url.pathname)) {
    const threadKey = decodeURIComponent(url.pathname.split('/').at(-1) ?? 'thread');
    return json(res, 200, { thread_key: threadKey, assignment_generation: 1 });
  }

  return json(res, 200, { ok: true });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`centaur stub listening on http://127.0.0.1:${port}`);
});
