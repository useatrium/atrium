import { describe, expect, it } from 'vitest';
import { isUnfurlableUrl } from './unfurl-contracts';
import {
  type InternalLinkRef,
  internalLinkKey,
  internalLinkPath,
  parseInternalLinkUrl,
  threadEntryHandle,
} from './internal-links';

const HOST = 'https://atrium.example.com';
const CH = '438eadcc-f7a8-4b91-acaf-378055a90312';
const SESS = 'de230f34-b9d9-42df-bce3-9270f2184294';

describe('parseInternalLinkUrl', () => {
  it('parses a channel-scoped session permalink', () => {
    expect(parseInternalLinkUrl(`${HOST}/c/${CH}/s/${SESS}`)).toEqual({
      kind: 'session',
      sessionId: SESS,
      channelId: CH,
    });
  });

  it('parses the legacy bare session permalink', () => {
    expect(parseInternalLinkUrl(`${HOST}/s/${SESS}`)).toEqual({
      kind: 'session',
      sessionId: SESS,
      channelId: null,
    });
  });

  it('parses a channel link and its members view', () => {
    expect(parseInternalLinkUrl(`${HOST}/c/${CH}`)).toEqual({ kind: 'channel', channelId: CH, membersOpen: false });
    expect(parseInternalLinkUrl(`${HOST}/c/${CH}/members`)).toEqual({
      kind: 'channel',
      channelId: CH,
      membersOpen: true,
    });
  });

  it('parses a thread link, coercing the root to a number', () => {
    expect(parseInternalLinkUrl(`${HOST}/c/${CH}/t/434`)).toEqual({ kind: 'thread', channelId: CH, rootEventId: 434 });
  });

  it('matches host-agnostically so a prod link resolves during local QA', () => {
    // The card renders a relative href, so this cannot navigate off-site.
    for (const host of ['http://localhost:5173', 'https://atrium.garybasin.com', 'https://anything.example']) {
      expect(parseInternalLinkUrl(`${host}/c/${CH}/s/${SESS}`)).toMatchObject({ kind: 'session', sessionId: SESS });
    }
  });

  it('ignores query params and fragments — they modify a view, not the place', () => {
    expect(parseInternalLinkUrl(`${HOST}/c/${CH}/s/${SESS}?view=focus&work=x#frag`)).toEqual({
      kind: 'session',
      sessionId: SESS,
      channelId: CH,
    });
  });

  it('leaves entry refs to the entry-quote pipeline', () => {
    expect(parseInternalLinkUrl(`${HOST}/e/evt_434`)).toBeNull();
  });

  it('rejects non-places and non-http(s) schemes', () => {
    for (const url of [
      `${HOST}/`,
      `${HOST}/files`,
      `${HOST}/settings/profile`,
      `${HOST}/c/${CH}/s`, // 3-segment, no session id
      `${HOST}/c/${CH}/x/${SESS}`, // unknown verb
      `${HOST}/c/${CH}/t/not-a-number`, // roots are bigserial
      `${HOST}/c/${CH}/t/-1`,
      `${HOST}/c//s/${SESS}`, // empty channel segment
      `javascript:alert(1)//c/${CH}`,
      'not a url',
    ]) {
      expect(parseInternalLinkUrl(url), url).toBeNull();
    }
  });

  it('refuses credentialed URLs rather than rendering a card for one', () => {
    expect(parseInternalLinkUrl(`https://evil:pw@atrium.example.com/c/${CH}`)).toBeNull();
  });
});

describe('threadEntryHandle', () => {
  it('derives the transparent evt_ handle a thread root already has', () => {
    const ref = parseInternalLinkUrl(`${HOST}/c/${CH}/t/434`) as Extract<InternalLinkRef, { kind: 'thread' }>;
    expect(threadEntryHandle(ref)).toBe('evt_434');
  });
});

describe('internalLinkPath', () => {
  it('always returns a relative path, never the pasted absolute URL', () => {
    // This is what makes host-agnostic matching safe: a card parsed from
    // evil.example can only ever link the reader back into this app.
    const refs: InternalLinkRef[] = [
      { kind: 'session', sessionId: SESS, channelId: CH },
      { kind: 'session', sessionId: SESS, channelId: null },
      { kind: 'channel', channelId: CH, membersOpen: false },
      { kind: 'channel', channelId: CH, membersOpen: true },
      { kind: 'thread', channelId: CH, rootEventId: 434 },
    ];
    for (const ref of refs) {
      const path = internalLinkPath(ref);
      expect(path.startsWith('/'), path).toBe(true);
      expect(path.startsWith('//'), path).toBe(false);
      expect(() => new URL(path)).toThrow(); // relative, not absolute
    }
  });

  it('round-trips a parsed link back to the same place', () => {
    for (const path of [`/c/${CH}/s/${SESS}`, `/s/${SESS}`, `/c/${CH}`, `/c/${CH}/members`, `/c/${CH}/t/434`]) {
      const ref = parseInternalLinkUrl(`${HOST}${path}`);
      expect(ref, path).not.toBeNull();
      expect(internalLinkPath(ref!)).toBe(path);
    }
  });
});

describe('internalLinkKey', () => {
  it('separates a channel from its members view but not a session from its channel', () => {
    expect(internalLinkKey({ kind: 'channel', channelId: CH, membersOpen: false })).not.toBe(
      internalLinkKey({ kind: 'channel', channelId: CH, membersOpen: true }),
    );
    // The same session reached via both permalink forms is one card.
    expect(internalLinkKey({ kind: 'session', sessionId: SESS, channelId: CH })).toBe(
      internalLinkKey({ kind: 'session', sessionId: SESS, channelId: null }),
    );
  });
});

describe('the external fetcher must never see an internal link', () => {
  it('regression: an Atrium permalink is unfurlable-looking, so parse must win first', () => {
    // isUnfurlableUrl says yes to our own links — that is exactly how a session
    // permalink reached the fetcher and came back as the Cloudflare Access
    // sign-in page, cached 24h as a successful og result. Callers MUST check
    // parseInternalLinkUrl before isUnfurlableUrl.
    const url = `https://atrium.garybasin.com/c/${CH}/s/${SESS}`;
    expect(isUnfurlableUrl(url)).toBe(true);
    expect(parseInternalLinkUrl(url)).not.toBeNull();
  });
});
