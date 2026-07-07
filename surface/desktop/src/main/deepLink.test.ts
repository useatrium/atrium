import assert from 'node:assert/strict';
import test from 'node:test';
import { deepLinkToRoute } from './deepLink.js';

test('maps atrium session links to legacy session routes', () => {
  assert.equal(deepLinkToRoute('atrium://s/session-123'), '/s/session-123');
  assert.equal(deepLinkToRoute('atrium:///s/session-123'), '/s/session-123');
});

test('maps https session share links from any host', () => {
  assert.equal(deepLinkToRoute('https://atrium.example/s/session-123'), '/s/session-123');
  assert.equal(deepLinkToRoute('https://example.com/s/session_123'), '/s/session_123');
});

test('maps entry links', () => {
  assert.equal(deepLinkToRoute('atrium://e/entry-handle'), '/e/entry-handle');
  assert.equal(deepLinkToRoute('https://example.com/e/entry-handle'), '/e/entry-handle');
});

test('maps channel links and ignores extra channel path suffixes', () => {
  assert.equal(deepLinkToRoute('atrium://c/channel-123'), '/c/channel-123');
  assert.equal(deepLinkToRoute('atrium://c/channel-123/s/session-123'), '/c/channel-123');
  assert.equal(deepLinkToRoute('https://example.com/c/channel-123/thread/abc'), '/c/channel-123');
});

test('maps atrium session aliases', () => {
  assert.equal(deepLinkToRoute('atrium://session/session-123'), '/s/session-123');
});

test('returns null for unsupported or malformed links', () => {
  assert.equal(deepLinkToRoute('not a url'), null);
  assert.equal(deepLinkToRoute('ftp://example.com/s/session-123'), null);
  assert.equal(deepLinkToRoute('atrium://settings'), null);
  assert.equal(deepLinkToRoute('https://example.com/settings'), null);
  assert.equal(deepLinkToRoute('atrium://s/'), null);
  assert.equal(deepLinkToRoute('atrium://s/session-123/extra'), null);
  assert.equal(deepLinkToRoute('https://example.com/session/session-123'), null);
});
