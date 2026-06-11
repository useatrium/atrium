// Session entity model lives in @atrium/surface-client (shared with mobile).
// This module re-exports it and keeps the web-only Centaur stream glue.

import type { ExecutionStatus } from '@atrium/centaur-client';
import type { SessionStatus } from '@atrium/surface-client';

export type {
  SessionStatus,
  SessionSeatUser,
  SeatChangeReason,
  SeatAuditEntry,
  QuestionPrompt,
  SessionWire,
  SessionListItem,
  Session,
} from '@atrium/surface-client';
export {
  sessionDriverId,
  PENDING_SESSION_PREFIX,
  isPendingSessionId,
  isTerminalSessionStatus,
  STALLED_AFTER_MS,
  isStalledSessionStatus,
  maxSessionStatus,
  asSessionStatus,
  sessionFromWire,
  mergeSpawnResponse,
  applySessionEvent,
  formatCost,
  formatElapsed,
} from '@atrium/surface-client';

/** Map a Centaur execution status (stream) onto the session status vocabulary. */
export function normalizeExecutionStatus(s: ExecutionStatus): SessionStatus {
  switch (s) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'failed_permanent':
      return 'failed';
    default:
      return 'running';
  }
}
