import assert from 'node:assert/strict';
import test from 'node:test';
import { deepLinkToRoute } from './deepLink.js';

const ACCEPTED_PATHS = [
  '/',
  '/c/channel-123',
  '/c/channel-123/s/session-123',
  '/c/channel-123/t/root-event-123',
  '/c/channel-123/members',
  '/s/session-123',
  '/s/session-123/pane',
  '/s/session-123/work/changes',
  '/e/entry-handle',
  '/files',
  '/activity',
  '/agents',
  '/settings',
  '/settings/profile',
] as const;

function atriumAuthorityUrlFor(path: string): string {
  return path === '/' ? 'atrium:///' : `atrium://${path.slice(1)}`;
}

function atriumPathUrlFor(path: string): string {
  return `atrium://${path}`;
}

function httpsUrlFor(path: string): string {
  return `https://atrium.example${path}`;
}

test('maps the full grammar for atrium authority-style links', () => {
  for (const path of ACCEPTED_PATHS) {
    assert.equal(deepLinkToRoute(atriumAuthorityUrlFor(path)), path, path);
  }
});

test('maps the full grammar for atrium path-style links', () => {
  for (const path of ACCEPTED_PATHS) {
    assert.equal(deepLinkToRoute(atriumPathUrlFor(path)), path, path);
  }
});

test('maps the full grammar for https share links from any host', () => {
  for (const path of ACCEPTED_PATHS) {
    assert.equal(deepLinkToRoute(httpsUrlFor(path)), path, path);
    assert.equal(deepLinkToRoute(`https://example.com${path}`), path, path);
  }
});

test('preserves the channel session route segment', () => {
  assert.equal(deepLinkToRoute('atrium://c/channel-123/s/session-123'), '/c/channel-123/s/session-123');
  assert.equal(deepLinkToRoute('https://example.com/c/channel-123/s/session-123'), '/c/channel-123/s/session-123');
});

test('preserves supported query params for atrium and https links', () => {
  const path = '/c/channel-123/s/session-123';
  const params = [
    'file=art_123',
    'panel=history',
    'work=changes',
    'dir=%2Fdocs%2F2026',
    'preview=apps%2Fdemo',
    'view=focus',
    'entry=evt_123',
    'threadRoot=root_123',
  ] as const;

  for (const param of params) {
    assert.equal(deepLinkToRoute(`${atriumAuthorityUrlFor(path)}?${param}`), `${path}?${param}`, param);
    assert.equal(deepLinkToRoute(`${httpsUrlFor(path)}?${param}`), `${path}?${param}`, param);
  }
});

test('preserves combined query strings unchanged', () => {
  const path = '/c/channel-123/s/session-123';
  const search =
    '?work=changes&file=art_123&panel=history&dir=%2Fdocs&preview=apps%2Fdemo&view=focus&entry=evt_123&threadRoot=root_123&extra=keep';

  assert.equal(deepLinkToRoute(`${atriumAuthorityUrlFor(path)}${search}`), `${path}${search}`);
  assert.equal(deepLinkToRoute(`${httpsUrlFor(path)}${search}`), `${path}${search}`);
});

test('maps atrium session aliases', () => {
  assert.equal(deepLinkToRoute('atrium://session/session-123'), '/s/session-123');
  assert.equal(deepLinkToRoute('atrium://session/session-123?view=focus'), '/s/session-123?view=focus');
});

test('returns null for unsupported or malformed links', () => {
  const rejected = [
    'not a url',
    'ftp://example.com/s/session-123',
    'atrium://unknown/id',
    'https://example.com/unknown/id',
    'atrium://c',
    'atrium://c/',
    'https://example.com/c/',
    'atrium://c//s/session-123',
    'https://example.com/c//s/session-123',
    'atrium://c/channel-123/s/',
    'https://example.com/c/channel-123/s/',
    'https://example.com/c/channel-123/thread/abc',
    'https://example.com/c/channel-123/members/extra',
    'atrium://s/',
    'https://example.com/s/',
    'atrium://s/session-123/extra',
    'https://example.com/s/session-123/work/',
    'https://example.com/e/entry-handle/extra',
    'https://example.com/files/extra',
    'https://example.com/activity/x',
    'https://example.com/agents/x',
    'https://example.com/settings/',
    'https://example.com/settings/profile/extra',
    'https://example.com/session/session-123',
    'atrium://session/',
    'atrium://session/session-123/extra',
    'https://example.com/s/%E0%A4%A',
  ] as const;

  for (const link of rejected) {
    assert.equal(deepLinkToRoute(link), null, link);
  }
});
