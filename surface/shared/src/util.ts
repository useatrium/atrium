import type { Channel } from './api';
import { isRenderableMessage, type ChatMessage, type UserRef } from './timeline';

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

/** Avatar source name without UI decorations such as "(you)". */
export function channelAvatarName(c: Channel, meId: string): string {
  return dmPartner(c, meId)?.displayName ?? channelLabel(c, meId);
}

function seedHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** WCAG relative luminance of an hsl() color (s/l in [0,100]). */
function hslLuminance(hue: number, s: number, l: number): number {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const lin = (v: number) => {
    const srgb = v + m;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Deterministic per-user avatar colors for a color scheme. Foreground
 * flips to near-black when white would land under 4.5:1 on the computed
 * background (warm hues), so initials meet AA on every hue in both schemes. */
const DARK_FG_LUM = 0.0031; // relative luminance of #0a0a0c

export function userColorTokens(seed: string, scheme: 'dark' | 'light' = 'dark'): { bg: string; fg: string } {
  const hue = seedHue(seed);
  const s = scheme === 'dark' ? 50 : 45;
  let l = scheme === 'dark' ? 42 : 46;
  let lum = hslLuminance(hue, s, l);
  // contrast vs white = 1.05 / (lum + 0.05); ≥4.5 requires lum ≤ 0.1833.
  // A narrow band of warm hues clears neither that nor 4.5 against the
  // near-black fg — darken those until white passes.
  while (lum > 0.1833 && (lum + 0.05) / (DARK_FG_LUM + 0.05) < 4.5 && l > 20) {
    l -= 1;
    lum = hslLuminance(hue, s, l);
  }
  const fg = lum <= 0.1833 ? '#ffffff' : '#0a0a0c';
  return { bg: `hsl(${hue} ${s}% ${l}%)`, fg };
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

function parseValidDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatExactTimestamp(iso: string): string {
  const date = parseValidDate(iso);
  if (!date) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelativeTimestamp(iso: string, now: Date = new Date()): string {
  const date = parseValidDate(iso);
  if (!date || Number.isNaN(now.getTime())) return '';
  const elapsedMs = Math.max(0, now.getTime() - date.getTime());
  if (elapsedMs < MINUTE_MS) return 'just now';
  const minutes = Math.floor(elapsedMs / MINUTE_MS);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(elapsedMs / HOUR_MS);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(elapsedMs / DAY_MS);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

/** Hover timestamp for a transcript turn: time-of-day today, day + time otherwise. */
export function formatTurnTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (sameDay(d, new Date())) return formatTime(iso);
  return `${formatDay(iso)}, ${formatTime(iso)}`;
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
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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
    if (!isRenderableMessage(m)) continue;
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
