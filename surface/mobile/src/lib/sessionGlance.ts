import {
  deriveSessionGlance,
  type Session,
  type SessionGlance,
  type SessionGlanceInput,
  type SessionGlanceKind,
  type SessionListItem,
} from '@atrium/surface-client';
import type { Colors } from './theme';

/** Theme color for a glance kind — one mapping for card, tab rows, and pins. */
export function glanceColor(kind: SessionGlanceKind, colors: Colors): string {
  if (kind === 'needs_you') return colors.warning;
  if (kind === 'done') return colors.online;
  if (kind === 'failed') return colors.danger;
  if (kind === 'stopped' || kind === 'stalled') return colors.textMuted;
  return colors.accent;
}

/** Glance from a REST list row + optional live entity (live wins). */
export function listItemGlance(
  item: Pick<SessionListItem, 'status' | 'createdAt' | 'completedAt'>,
  live: Session | undefined,
  now: number,
): SessionGlance {
  const input: SessionGlanceInput = live ?? {
    status: item.status,
    pendingSeatRequests: [],
    createdAt: item.createdAt,
    completedAt: item.completedAt,
  };
  return deriveSessionGlance(input, now);
}
