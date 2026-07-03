import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWindowOpen } from './windowOpenPolicy.js';

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
