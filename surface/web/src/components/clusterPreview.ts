import { isHumanBroadcastReply, type ChatMessage } from '@atrium/surface-client';

export interface ClusterPreview {
  latest: ChatMessage | null;
  latestIsAnchored: boolean;
  earlierCount: number;
  earlierLabel: string;
}

/** Derive the compact row and collapsed-count copy for a channel annotation cluster. */
export function deriveClusterPreview(root: ChatMessage, answers: readonly ChatMessage[]): ClusterPreview {
  const anchoredMaxId = answers.reduce((acc, answer) => Math.max(acc, answer.id ?? 0), 0);
  const previewCandidate = root.lastReply != null && !isHumanBroadcastReply(root.lastReply) ? root.lastReply : null;
  const previewIsAnchored =
    previewCandidate != null &&
    answers.some(
      (answer) =>
        (answer.id != null && answer.id === previewCandidate.id) ||
        (answer.clientMsgId != null && answer.clientMsgId === previewCandidate.clientMsgId),
    );
  const latest =
    previewCandidate != null && !previewIsAnchored && (previewCandidate.id ?? 0) > anchoredMaxId
      ? previewCandidate
      : (answers.at(-1) ?? previewCandidate);
  const latestIsAnchored = latest != null && (answers.includes(latest) || previewIsAnchored);
  const earlierCount = Math.max(0, root.replyCount - (latest ? 1 : 0));
  const noun = earlierCount === 1 ? 'reply' : 'replies';
  const earlierLabel = `${earlierCount}${latest ? ' earlier' : ''} ${noun}`;

  return { latest, latestIsAnchored, earlierCount, earlierLabel };
}
