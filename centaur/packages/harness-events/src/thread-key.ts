export function splitThreadKey(threadKey: string): { channel: string; threadTs: string } {
  const parts = threadKey.trim().split(":");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { channel: parts[0], threadTs: parts[1] };
  }
  if (parts.length === 3 && parts[1] && parts[2]) {
    return { channel: parts[1], threadTs: parts[2] };
  }
  throw new Error(`Invalid thread key format (expected <channel>:<thread_ts>): ${threadKey}`);
}

export function normalizeThreadKey(threadKey: string): string {
  const { channel, threadTs } = splitThreadKey(threadKey);
  return `${channel}:${threadTs}`;
}
