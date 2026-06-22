import { describe, expect, it } from 'vitest';
import { projectChatThread, renderChatMarkdown, type ChatEvent } from '../src/atrium-projection.js';

describe('atrium chat projection (§8B #6 — current view, not append-tail)', () => {
  it('applies edits and deletes, preserving post order', () => {
    const events: ChatEvent[] = [
      { kind: 'message', id: 'm1', author: 'alice', text: 'hello', ts: 1 },
      { kind: 'message', id: 'm2', author: 'bob', text: 'draft', ts: 2 },
      { kind: 'edit', id: 'e1', ref: 'm2', text: 'final', ts: 3 },
      { kind: 'message', id: 'm3', author: 'carol', text: 'oops', ts: 4 },
      { kind: 'delete', id: 'd1', ref: 'm3', ts: 5 },
    ];
    const { messages } = projectChatThread(events);
    expect(messages.map((m) => [m.author, m.text])).toEqual([
      ['alice', 'hello'],
      ['bob', 'final'],
    ]);
    expect(messages[1]!.edited).toBe(true);
  });

  it('redaction replaces the body — the original text never appears (no re-disclosure)', () => {
    const events: ChatEvent[] = [
      { kind: 'message', id: 'm1', author: 'alice', text: 'my password is hunter2', ts: 1 },
      { kind: 'redact', id: 'r1', ref: 'm1', ts: 2 },
    ];
    const { messages } = projectChatThread(events);
    expect(messages[0]!.text).toBe('[redacted]');
    expect(messages[0]!.redacted).toBe(true);
    const md = renderChatMarkdown('secrets', events);
    expect(md).not.toContain('hunter2'); // the load-bearing invariant
    expect(md).toContain('(redacted)');
  });

  it('an edit after a redaction does not resurrect content', () => {
    const events: ChatEvent[] = [
      { kind: 'message', id: 'm1', author: 'alice', text: 'secret', ts: 1 },
      { kind: 'redact', id: 'r1', ref: 'm1', ts: 2 },
      { kind: 'edit', id: 'e1', ref: 'm1', text: 'secret again', ts: 3 },
    ];
    const { messages } = projectChatThread(events);
    expect(messages[0]!.text).toBe('[redacted]');
  });

  it('renders a markdown current view an agent can cat', () => {
    const md = renderChatMarkdown('general', [
      { kind: 'message', id: 'm1', author: 'agent:s1', text: 'shipped the fix', ts: 1 },
    ]);
    expect(md).toContain('# general');
    expect(md).toContain('**agent:s1**: shipped the fix');
  });
});
