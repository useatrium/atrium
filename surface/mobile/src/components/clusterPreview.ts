import { isHumanBroadcastReply, type ChatMessage } from '@atrium/surface-client';

type MessageWithLastReply = ChatMessage & { lastReply?: ChatMessage | null };

export interface ClusterPreview {
  answerIds: ReadonlySet<number>;
  loadedReplies: ChatMessage[];
  payloadLatest: ChatMessage | null;
  latestAnswer: ChatMessage | null;
  latest: ChatMessage | null;
  earlierCount: number;
  earlierReplies: ChatMessage[];
  toggleLabel: string;
}

export function deriveClusterPreview(
  root: ChatMessage,
  replies: ChatMessage[] | undefined,
  slotAnswers: ChatMessage[],
): ClusterPreview {
  const answerIds = new Set(slotAnswers.map((answer) => answer.id).filter((id): id is number => id != null));
  const loadedReplies = (replies ?? []).filter((reply) => !answerIds.has(reply.id ?? -1));
  const rawPayloadLatest = (root as MessageWithLastReply).lastReply ?? null;
  const payloadLatest = rawPayloadLatest && !isHumanBroadcastReply(rawPayloadLatest) ? rawPayloadLatest : null;
  const latestAnswer = slotAnswers.find((answer) => answer.id === root.lastReplyId) ?? null;
  const latest = latestAnswer ? null : (loadedReplies.at(-1) ?? payloadLatest);
  const earlierCount = Math.max(0, root.replyCount - (latest != null || latestAnswer != null ? 1 : 0));
  const earlierReplies = latest ? loadedReplies.filter((reply) => reply.id !== latest.id) : loadedReplies;
  const qualifier = latest ? ' earlier' : '';
  const toggleLabel = `${earlierCount}${qualifier} ${earlierCount === 1 ? 'reply' : 'replies'}`;

  return {
    answerIds,
    loadedReplies,
    payloadLatest,
    latestAnswer,
    latest,
    earlierCount,
    earlierReplies,
    toggleLabel,
  };
}
