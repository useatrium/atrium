import { sessionDriverId } from '@atrium/surface-client';
import type { Session } from './types';

// === nudge additions ===
export type FailedSessionNudge = {
  channelId: string;
  threadRootEventId: number;
  text: string;
  driverName: string;
  title: string;
};

export function failedSessionNudge(session: Session): FailedSessionNudge | null {
  if (session.status !== 'failed' || session.threadRootEventId == null) return null;
  const driverName = session.driverName ?? session.spawnerName ?? 'the driver';
  return {
    channelId: session.channelId,
    threadRootEventId: session.threadRootEventId,
    text: `<@${sessionDriverId(session)}> this run failed — worth a retry?`,
    driverName,
    title: session.title,
  };
}
