import type { ChatMessage } from './state';

/** Deterministic accent color per user (no avatars — colored initials).
 * Lightness 42% keeps white initials readable across the whole hue wheel. */
export function userColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 50% 42%)`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Compact 24h time for the 32px message gutter — "7:54 PM" wraps there. */
export function formatGutterTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export interface TimelineItem {
  kind: 'day' | 'message';
  key: string;
  label?: string;
  message?: ChatMessage;
  /** True when this message continues a group (same author, < 5 min gap). */
  grouped?: boolean;
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Build render items: day separators + consecutive-message grouping.
 * Deleted messages disappear unless they anchor a thread (tombstone). */
export function buildTimelineItems(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let prev: ChatMessage | null = null;
  for (const m of messages) {
    if (m.deleted && m.replyCount === 0) continue;
    const d = new Date(m.createdAt);
    if (!prev || !sameDay(new Date(prev.createdAt), d)) {
      items.push({ kind: 'day', key: `day-${d.toDateString()}`, label: formatDay(m.createdAt) });
      prev = null;
    }
    const grouped =
      prev != null &&
      prev.author.id === m.author.id &&
      d.getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
    items.push({
      kind: 'message',
      key: m.id != null ? `e${m.id}` : `c${m.clientMsgId}`,
      message: m,
      grouped,
    });
    prev = m;
  }
  return items;
}
