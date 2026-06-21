// `/atrium/chat/<ch>/<thread>.md` projection (§2A / §8B #6). The node maintains a
// read-only context tree for agents; chat is projected from the events log as a
// DEBOUNCED RE-RENDERED CURRENT VIEW — edits/deletes/redactions are applied — NOT
// an append-tail. The distinction is load-bearing for safety: an append-tail would
// keep a redacted secret's original bytes forever; the current view replaces them.
// (Raw events still live in a sibling `…events.jsonl` for audit; transcripts —
// which are genuinely append-only — stay append-tail.)

export type ChatEvent =
  | { kind: 'message'; id: string; author: string; text: string; ts: number }
  | { kind: 'edit'; id: string; ref: string; text: string; ts: number }
  | { kind: 'delete'; id: string; ref: string; ts: number }
  | { kind: 'redact'; id: string; ref: string; ts: number };

export interface ProjectedMessage {
  id: string;
  author: string;
  text: string;
  edited: boolean;
  redacted: boolean;
}

/** Fold the event log into the current set of visible messages, in original
 * post order. Edits replace text; deletes drop the message; redactions replace
 * the body with a tombstone (the original text never appears in the output). */
export function projectChatThread(events: ChatEvent[]): {
  messages: ProjectedMessage[];
  eventCount: number;
} {
  const byId = new Map<string, ProjectedMessage>();
  const order: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case 'message':
        if (!byId.has(e.id)) order.push(e.id);
        byId.set(e.id, { id: e.id, author: e.author, text: e.text, edited: false, redacted: false });
        break;
      case 'edit': {
        const m = byId.get(e.ref);
        if (m && !m.redacted) {
          m.text = e.text;
          m.edited = true;
        }
        break;
      }
      case 'delete':
        byId.delete(e.ref);
        break;
      case 'redact': {
        const m = byId.get(e.ref);
        if (m) {
          m.text = '[redacted]';
          m.redacted = true;
        }
        break;
      }
    }
  }
  return { messages: order.filter((id) => byId.has(id)).map((id) => byId.get(id)!), eventCount: events.length };
}

/** Render the current view as the `<thread>.md` an agent greps/cats. */
export function renderChatMarkdown(threadTitle: string, events: ChatEvent[]): string {
  const { messages } = projectChatThread(events);
  const lines = [`# ${threadTitle}`, ''];
  for (const m of messages) {
    const tag = m.redacted ? ' (redacted)' : m.edited ? ' (edited)' : '';
    lines.push(`**${m.author}**${tag}: ${m.text}`);
  }
  return lines.join('\n') + '\n';
}
