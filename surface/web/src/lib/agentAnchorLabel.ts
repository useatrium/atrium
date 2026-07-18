import { encodeEventHandle } from '@atrium/surface-client/handle';

const ANCHOR_SNIPPET_MAX = 40;

type AnchorMessage = {
  id: number;
  text: string;
  author: { displayName: string };
};

export function agentAnchorLabel(message: AnchorMessage): string {
  const oneLine = message.text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return `/e/${encodeEventHandle(message.id)}`;
  const snippet =
    oneLine.length > ANCHOR_SNIPPET_MAX ? `${oneLine.slice(0, ANCHOR_SNIPPET_MAX - 1).trimEnd()}…` : oneLine;
  return `${message.author.displayName}: ${snippet}`;
}
