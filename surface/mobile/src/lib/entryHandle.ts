import type { ChatMessage } from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';

type MessageWithHandle = ChatMessage & { handle?: string | null };

export function entryHandleForMessage(message: ChatMessage | null | undefined): string | null {
  if (!message || message.deleted === true || message.status !== 'confirmed') return null;
  if (message.sessionId != null || message.sessionEventType != null) return null;

  const explicitHandle = (message as MessageWithHandle).handle;
  if (typeof explicitHandle === 'string' && explicitHandle.length > 0) return explicitHandle;
  return message.id != null ? encodeEventHandle(message.id) : null;
}
