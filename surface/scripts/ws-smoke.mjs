#!/usr/bin/env node
// WS smoke test: proves login → subscribe → post → WS fanout works end-to-end
// against a running server, and measures send→deliver latency.
//
// Usage: node scripts/ws-smoke.mjs [count]
//   BASE_URL=http://localhost:3001 by default.

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const WS_BASE = BASE.replace(/^http/, 'ws');
const COUNT = Number(process.argv[2] ?? 20);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function login(handle, displayName) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, displayName }),
  });
  if (!res.ok) fail(`login ${handle}: HTTP ${res.status}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) fail(`login ${handle}: no session cookie`);
  const { user } = await res.json();
  return { cookie, user };
}

const alice = await login('smoke-alice', 'Smoke Alice');
const bob = await login('smoke-bob', 'Smoke Bob');
console.log(`logged in: ${alice.user.handle} (${alice.user.id}), ${bob.user.handle}`);

const chRes = await fetch(`${BASE}/api/channels`, { headers: { cookie: alice.cookie } });
if (!chRes.ok) fail(`GET /api/channels: HTTP ${chRes.status}`);
const { channels } = await chRes.json();
const general = channels.find((c) => c.name === 'general') ?? channels[0];
if (!general) fail('no channels found');
console.log(`channel: #${general.name} (${general.id})`);

// --- connect Alice over WS, subscribe to #general ---
const ws = new WebSocket(`${WS_BASE}/ws`, { headers: { cookie: alice.cookie } });
const received = []; // { event, at }
let presenceSeen = null;

const wsOpen = new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'event') received.push({ event: msg.event, at: performance.now() });
  if (msg.type === 'presence' && msg.channelId === general.id) presenceSeen = msg.users;
});
await wsOpen;
ws.send(JSON.stringify({ type: 'subscribe', channelIds: [general.id] }));
await new Promise((r) => setTimeout(r, 300));
if (!presenceSeen) fail('no presence snapshot after subscribe');
console.log(`presence in #general: ${presenceSeen.map((u) => u.handle).join(', ')}`);

// --- Bob posts COUNT messages over REST; Alice should see each over WS ---
const sent = new Map(); // clientMsgId -> t0
for (let i = 0; i < COUNT; i++) {
  const clientMsgId = randomUUID();
  const t0 = performance.now();
  sent.set(clientMsgId, t0);
  const res = await fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: bob.cookie },
    body: JSON.stringify({ channelId: general.id, text: `smoke message ${i}`, clientMsgId }),
  });
  if (res.status !== 201) fail(`POST /api/messages #${i}: HTTP ${res.status}`);
  await new Promise((r) => setTimeout(r, 25));
}

// wait for fanout to drain
const deadline = Date.now() + 5000;
while (received.length < COUNT && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}
ws.close();

// --- verify ---
const events = received.filter((r) => r.event.type === 'message.posted');
if (events.length !== COUNT) fail(`expected ${COUNT} events over WS, got ${events.length}`);

const ids = events.map((r) => r.event.id);
for (let i = 1; i < ids.length; i++) {
  if (ids[i] <= ids[i - 1]) fail(`fanout out of order: ${ids[i - 1]} then ${ids[i]}`);
}

const latencies = [];
for (const r of events) {
  const cmid = r.event.payload?.client_msg_id;
  if (!cmid || !sent.has(cmid)) fail(`event ${r.event.id} missing/unknown client_msg_id`);
  if (!r.event.author || r.event.author.handle !== 'smoke-bob') {
    fail(`event ${r.event.id} has wrong author: ${JSON.stringify(r.event.author)}`);
  }
  latencies.push(r.at - sent.get(cmid));
}

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
console.log('');
console.log(`OK: ${COUNT} messages posted by bob → all received on alice's WS, in id order`);
console.log(`OK: every event echoed its client_msg_id and author`);
console.log(
  `send→WS-deliver latency over ${COUNT} msgs: p50=${pct(50).toFixed(1)}ms p95=${pct(95).toFixed(1)}ms max=${latencies[latencies.length - 1].toFixed(1)}ms`,
);
process.exit(0);
