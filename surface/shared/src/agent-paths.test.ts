import { describe, expect, it } from 'vitest';
import {
  agentPathBasename,
  agentPathFromLocationPath,
  agentPathWebUrl,
  isSelfDescribingAgentPath,
  parseAgentPathHref,
} from './agent-paths.js';

const CHAN = '121a247c-e270-4783-a9d4-cb80ec984188';
const SESS = 'ae8872fa-b108-4c85-a175-d58f073e122e';

describe('parseAgentPathHref', () => {
  // The incident shape: the reply from prod session ae8872fa linked exactly this.
  it('parses the absolute sandbox path to a shared channel file', () => {
    const ref = parseAgentPathHref(`/home/agent/shared/channels/${CHAN}/atrium-first-customer-prospects.md`);
    expect(ref).toEqual({
      kind: 'shared-channel',
      channelId: CHAN,
      relPath: 'atrium-first-customer-prospects.md',
      canonicalPath: `shared/channels/${CHAN}/atrium-first-customer-prospects.md`,
    });
  });

  it('parses tilde and workspace-prefixed variants to the same ref', () => {
    const canonical = parseAgentPathHref(`/home/agent/shared/channels/${CHAN}/a/b.md`);
    for (const href of [
      `~/shared/channels/${CHAN}/a/b.md`,
      `/home/agent/workspace/shared/channels/${CHAN}/a/b.md`,
      `~/workspace/shared/channels/${CHAN}/a/b.md`,
      `shared/channels/${CHAN}/a/b.md`,
      `/shared/channels/${CHAN}/a/b.md`,
    ]) {
      expect(parseAgentPathHref(href), href).toEqual(canonical);
    }
  });

  it('parses scratch paths with a session uuid', () => {
    const ref = parseAgentPathHref(`scratch/${SESS}/draft.md`);
    expect(ref).toEqual({
      kind: 'scratch',
      sessionId: SESS,
      relPath: 'draft.md',
      canonicalPath: `scratch/${SESS}/draft.md`,
    });
  });

  it('parses shared/global and shared/apps as generic shared refs', () => {
    expect(parseAgentPathHref('/home/agent/shared/global/team-notes.md')).toEqual({
      kind: 'shared',
      canonicalPath: 'shared/global/team-notes.md',
    });
    expect(parseAgentPathHref('shared/apps/dashboard/index.html')).toEqual({
      kind: 'shared',
      canonicalPath: 'shared/apps/dashboard/index.html',
    });
  });

  it('classifies bare home paths as workspace-relative', () => {
    expect(parseAgentPathHref('/home/agent/notes.md')).toEqual({ kind: 'workspace-relative', relPath: 'notes.md' });
    expect(parseAgentPathHref('~/reports/q3.csv')).toEqual({ kind: 'workspace-relative', relPath: 'reports/q3.csv' });
  });

  it('never chips ordinary links', () => {
    for (const href of [
      'https://example.com/shared/channels/x.md',
      'mailto:a@b.c',
      'atrium-entry:abc123',
      '/e/abc123',
      '/c/some/where',
      'notes.md',
      './notes.md',
      'docs/readme.md',
      '',
    ]) {
      expect(parseAgentPathHref(href), href).toBeNull();
    }
  });

  it('rejects non-artifact roots under the agent home', () => {
    for (const href of [
      '/home/agent/repos/useatrium/atrium/README.md',
      '~/context/channels/index.md',
      '/home/agent/.codex/config.toml',
      '/home/agent/tmp/scratch.txt',
    ]) {
      expect(parseAgentPathHref(href), href).toBeNull();
    }
  });

  it('rejects malformed shared/scratch shapes instead of downgrading them', () => {
    for (const href of [
      `shared/channels/${CHAN}`, // no file segment
      'shared/channels/not-a-uuid/file.md',
      'shared/secrets/file.md',
      'scratch/not-a-uuid/file.md',
      `scratch/${SESS}`, // no file segment
      '/home/agent/shared', // bare root
    ]) {
      expect(parseAgentPathHref(href), href).toBeNull();
    }
  });

  it('rejects traversal and normalizes dot segments', () => {
    expect(parseAgentPathHref(`/home/agent/shared/channels/${CHAN}/../../etc/passwd`)).toBeNull();
    expect(parseAgentPathHref(`/home/agent/shared/channels/${CHAN}/./a//b.md`)).toEqual(
      expect.objectContaining({ canonicalPath: `shared/channels/${CHAN}/a/b.md` }),
    );
  });

  it('decodes percent-encoding and strips query/fragment', () => {
    const ref = parseAgentPathHref(`/home/agent/shared/channels/${CHAN}/notes%20v2.md?raw=1#top`);
    expect(ref).toEqual(expect.objectContaining({ relPath: 'notes v2.md' }));
    expect(parseAgentPathHref('/home/agent/shared/channels/%ZZ/file.md')).toBeNull();
  });

  it('lowercases uuids in canonical paths', () => {
    const ref = parseAgentPathHref(`shared/channels/${CHAN.toUpperCase()}/f.md`);
    expect(ref).toEqual(expect.objectContaining({ channelId: CHAN }));
  });
});

describe('agentPathWebUrl / isSelfDescribingAgentPath', () => {
  it('builds /f/ URLs for self-describing refs only', () => {
    const shared = parseAgentPathHref(`/home/agent/shared/channels/${CHAN}/notes v2.md`);
    expect(shared && isSelfDescribingAgentPath(shared)).toBe(true);
    expect(shared && agentPathWebUrl(shared)).toBe(`/f/shared/channels/${CHAN}/notes%20v2.md`);

    const rel = parseAgentPathHref('/home/agent/notes.md');
    expect(rel && isSelfDescribingAgentPath(rel)).toBe(false);
    expect(rel && agentPathWebUrl(rel)).toBeNull();
  });
});

describe('agentPathBasename', () => {
  it('returns the last segment for labels', () => {
    const ref = parseAgentPathHref(`/home/agent/shared/channels/${CHAN}/a/b/c.md`);
    expect(ref && agentPathBasename(ref)).toBe('c.md');
    const rel = parseAgentPathHref('~/x/y.txt');
    expect(rel && agentPathBasename(rel)).toBe('y.txt');
  });
});

describe('agentPathFromLocationPath', () => {
  it('resolves /f/ routes and raw sandbox URLs, self-describing only', () => {
    expect(agentPathFromLocationPath(`/f/shared/channels/${CHAN}/notes%20v2.md`)).toEqual(
      expect.objectContaining({ kind: 'shared-channel', relPath: 'notes v2.md' }),
    );
    expect(agentPathFromLocationPath(`/home/agent/shared/channels/${CHAN}/f.md`)).toEqual(
      expect.objectContaining({ kind: 'shared-channel' }),
    );
    // A bare workspace path in a URL has no session context — must not resolve.
    expect(agentPathFromLocationPath('/home/agent/notes.md')).toBeNull();
    expect(agentPathFromLocationPath('/f/notes.md')).toBeNull();
    expect(agentPathFromLocationPath('/c/123/t/423')).toBeNull();
  });
});
