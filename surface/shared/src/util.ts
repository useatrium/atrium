import type { Channel } from './api';
import type { ChatMessage, UserRef } from './timeline';

/** The person on the other side of a DM (yourself, for a self-DM). */
export function dmPartner(c: Channel, meId: string): UserRef | null {
  if (c.kind !== 'dm' || !c.members || c.members.length === 0) return null;
  return c.members.find((m) => m.id !== meId) ?? c.members[0]!;
}

/** Sidebar/header label: "#name" channels render their name, DMs the person. */
export function channelLabel(c: Channel, meId: string): string {
  if (c.kind === 'gdm' && c.members && c.members.length > 0) {
    const others = c.members.filter((m) => m.id !== meId);
    const names = (others.length > 0 ? others : c.members).map((m) => m.displayName);
    return names.join(', ');
  }
  const partner = dmPartner(c, meId);
  if (!partner) return c.name;
  return partner.id === meId ? `${partner.displayName} (you)` : partner.displayName;
}

/** Deterministic accent color per user (no avatars — colored initials).
 * Lightness 42% keeps white initials readable across the whole hue wheel. */
export function userColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 50% 42%)`;
}

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/^[^\p{Letter}\p{Number}]+/u, ''))
    .filter(Boolean);
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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

/**
 * UUIDv4 that works on insecure origins. Browsers expose crypto.randomUUID
 * only in secure contexts (https/localhost) — plain-HTTP deployments (e.g.
 * the web client served over a Tailscale IP) still need client message ids.
 */
export function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
