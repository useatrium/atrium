/**
 * Contract for INTERNAL link cards — Atrium URLs pasted into Atrium chat.
 *
 * Why this exists: an Atrium permalink must never reach the external unfurl
 * fetcher. That fetcher is an unauthenticated public-internet client, so behind
 * an access proxy (Cloudflare Access et al) it fetches the *sign-in page*,
 * scrapes its `<title>`, and caches that as a successful `kind:'og'` result for
 * 24h. Nothing errors; the wrong answer just looks like a right one. Even with
 * a service token it would still be wrong: `web/index.html` carries no OG tags,
 * and `link_unfurls` is keyed on `sha256(url)` with no user dimension, so
 * ACL-scoped content in it would leak across users on the first cache hit.
 *
 * So internal links never traverse HTTP. They are parsed here and resolved from
 * state the client already holds under the viewer's own ACL:
 *
 *   /c/:channelId/s/:sessionId  ->  session card   (state.sessions[id])
 *   /s/:sessionId               ->  session card   (legacy permalink)
 *   /c/:channelId               ->  channel card   (state.channels)
 *   /c/:channelId/members       ->  channel card   (members emphasis)
 *   /c/:channelId/t/:rootId     ->  entry quote    (see threadEntryHandle)
 *
 * `/e/<handle>` is deliberately NOT parsed here — it is already owned by the
 * entry-quote pipeline (see `entry-contracts.ts`). Callers exclude both before
 * calling `isUnfurlableUrl`.
 *
 * MATCHING IS HOST-AGNOSTIC, mirroring the entry-ref rule, so a link copied
 * from prod still resolves against localhost during QA. That is only safe
 * because a card renders a RELATIVE in-app href (`internalLinkPath`) and never
 * the pasted absolute URL — a card can therefore never navigate a reader to
 * whatever host was actually in the link. Any renderer that links out to the
 * original URL breaks that guarantee and reintroduces a phishing vector.
 */

/** A parsed reference to something inside Atrium. */
export type InternalLinkRef =
  | { kind: 'session'; sessionId: string; channelId: string | null }
  | { kind: 'channel'; channelId: string; membersOpen: boolean }
  | { kind: 'thread'; channelId: string; rootEventId: number };

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Parse an absolute http(s) Atrium URL into a ref, or null when it is not an
 * internal link. Mirrors the grammar in `web/src/router.ts` (`parseInAppRoute`)
 * — keep the two in step; that module owns navigation, this one owns cards.
 *
 * Query strings and fragments are ignored: `?work=…` / `#x` are view modifiers
 * layered on a place, and the card names the place.
 */
export function parseInternalLinkUrl(url: string): InternalLinkRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Credentialed URLs are never ours; refuse rather than render a card for one.
  if (parsed.username || parsed.password) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  // /s/:sessionId — legacy permalink, no channel in the path.
  if (parts.length === 2 && parts[0] === 's') {
    const sessionId = decodeSegment(parts[1]!);
    return sessionId ? { kind: 'session', sessionId, channelId: null } : null;
  }

  if (parts[0] !== 'c') return null;

  // /c/:channelId
  if (parts.length === 2) {
    const channelId = decodeSegment(parts[1]!);
    return channelId ? { kind: 'channel', channelId, membersOpen: false } : null;
  }

  // /c/:channelId/members
  if (parts.length === 3 && parts[2] === 'members') {
    const channelId = decodeSegment(parts[1]!);
    return channelId ? { kind: 'channel', channelId, membersOpen: true } : null;
  }

  if (parts.length !== 4) return null;
  const channelId = decodeSegment(parts[1]!);
  const tail = decodeSegment(parts[3]!);
  if (!channelId || !tail) return null;

  // /c/:channelId/s/:sessionId
  if (parts[2] === 's') return { kind: 'session', sessionId: tail, channelId };

  // /c/:channelId/t/:rootId — roots are `events.id`, a bigserial. The router
  // coerces this segment with Number(); anything non-numeric is not a place.
  if (parts[2] === 't') {
    if (!/^\d+$/.test(tail)) return null;
    const rootEventId = Number(tail);
    if (!Number.isSafeInteger(rootEventId) || rootEventId < 0) return null;
    return { kind: 'thread', channelId, rootEventId };
  }

  return null;
}

/**
 * A thread permalink IS an entry ref wearing a different hat. `evt_<id>` is a
 * transparent, derivable handle over `events.id` (see `handle.ts` decision H8),
 * and thread roots are events. So `/c/:id/t/:rootId` resolves through the
 * existing entry-quote pipeline — which already renders a root message's text,
 * author, and channel/session location — instead of a bespoke card and a new
 * endpoint. Returns the handle to hand to `resolveEntryQuote`.
 */
export function threadEntryHandle(ref: Extract<InternalLinkRef, { kind: 'thread' }>): string {
  return `evt_${ref.rootEventId}`;
}

/**
 * The RELATIVE in-app path a card must link to. Never link a card to the URL it
 * was parsed from: see the host-agnostic note in the module doc.
 */
export function internalLinkPath(ref: InternalLinkRef): string {
  switch (ref.kind) {
    case 'session':
      return ref.channelId
        ? `/c/${encodeURIComponent(ref.channelId)}/s/${encodeURIComponent(ref.sessionId)}`
        : `/s/${encodeURIComponent(ref.sessionId)}`;
    case 'channel':
      return ref.membersOpen
        ? `/c/${encodeURIComponent(ref.channelId)}/members`
        : `/c/${encodeURIComponent(ref.channelId)}`;
    case 'thread':
      return `/c/${encodeURIComponent(ref.channelId)}/t/${ref.rootEventId}`;
  }
}

/** Stable identity for dedupe/suppression bookkeeping. */
export function internalLinkKey(ref: InternalLinkRef): string {
  switch (ref.kind) {
    case 'session':
      return `session:${ref.sessionId}`;
    case 'channel':
      return `channel:${ref.channelId}${ref.membersOpen ? ':members' : ''}`;
    case 'thread':
      return `thread:${ref.rootEventId}`;
  }
}
