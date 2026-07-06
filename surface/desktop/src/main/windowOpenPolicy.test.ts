import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSessionPopoutOpen,
  resolveWindowOpen,
  sessionIdFromPanePath,
} from './windowOpenPolicy.js';

const ctx = {
  appOrigin: 'app://atrium',
  devOrigin: 'http://localhost:5173',
};

test('allows packaged session pane popouts', () => {
  assert.deepEqual(resolveWindowOpen('app://atrium/s/session-123/pane', ctx), { kind: 'popout' });
});

test('allows dev server session pane popouts', () => {
  assert.deepEqual(resolveWindowOpen('http://localhost:5173/s/session-123/pane', ctx), {
    kind: 'popout',
  });
});

test('denies same-origin dev server non-pane paths', () => {
  assert.deepEqual(resolveWindowOpen('http://localhost:5173/s/session-123', ctx), { kind: 'deny' });
});

test('opens external https URLs outside the shell', () => {
  assert.deepEqual(resolveWindowOpen('https://example.com/s/session-123/pane', ctx), { kind: 'external' });
});

test('denies other app URLs', () => {
  assert.deepEqual(resolveWindowOpen('app://atrium/settings', ctx), { kind: 'deny' });
});

test('denies garbage URLs', () => {
  assert.deepEqual(resolveWindowOpen('not a url', ctx), { kind: 'deny' });
});

test('extracts session ids from pane paths', () => {
  assert.equal(sessionIdFromPanePath('/s/session-123/pane'), 'session-123');
  assert.equal(sessionIdFromPanePath('/s/session_123/pane'), 'session_123');
});

test('rejects non-pane paths when extracting session ids', () => {
  assert.equal(sessionIdFromPanePath('/s/session-123'), null);
  assert.equal(sessionIdFromPanePath('/s/session-123/pane/extra'), null);
  assert.equal(sessionIdFromPanePath('/s//pane'), null);
});

test('creates a popout when there is no live registered window', () => {
  assert.deepEqual(resolveSessionPopoutOpen('session-123', 'missing'), {
    action: 'create',
    sessionId: 'session-123',
  });
  assert.deepEqual(resolveSessionPopoutOpen('session-123', 'destroyed'), {
    action: 'create',
    sessionId: 'session-123',
  });
});

test('focuses an existing live popout', () => {
  assert.deepEqual(resolveSessionPopoutOpen('session-123', 'live'), {
    action: 'focus',
    sessionId: 'session-123',
  });
});

test('denies popout open decisions without a session id', () => {
  assert.deepEqual(resolveSessionPopoutOpen(null, 'missing'), { action: 'deny' });
});
