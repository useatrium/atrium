import { useState } from 'react';
import { internalLinkPath, type InternalLinkRef } from '@atrium/surface-client/internal-links';
import { channelLabel, type Channel } from '@atrium/surface-client';
import { GlanceChip } from '../sessions/GlanceChip';
import { useNow } from '../sessions/SessionCard';
import { useSessionsContext } from '../sessions/SessionsContext';
import { isTerminalSessionStatus } from '../sessions/types';
import { CardControls } from './EntryQuoteCard';
import { LockIcon } from './icons';

function harnessLabel(harness: string): string {
  if (harness === 'codex') return 'Codex agent';
  if (harness === 'claude-code') return 'Claude Code agent';
  return `${harness} agent`;
}

function channelMemberCount(channel: Channel): number | null {
  if (channel.kind === 'private') return channel.memberCount ?? null;
  if (channel.kind === 'dm' || channel.kind === 'gdm') return channel.members?.length ?? null;
  return null;
}

/**
 * One channel identity for both card kinds. A DM's label is its partner's name,
 * so a hardcoded "#" would render "#alice" — hence `channelLabel`, the same
 * helper the sidebar and pane header use, plus a kind-appropriate affordance.
 */
function ChannelRef({ channel, meId }: { channel: Channel; meId?: string }) {
  const label = channelLabel(channel, meId ?? '');
  const isConversation = channel.kind === 'dm' || channel.kind === 'gdm';
  return (
    <>
      <span className="grid w-4 shrink-0 place-items-center text-fg-muted">
        {channel.kind === 'private' ? (
          <LockIcon size={14} />
        ) : (
          <span aria-hidden="true">{isConversation ? '@' : '#'}</span>
        )}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
}

export function InternalLinkCard({
  linkRef,
  meId,
  onSuppress,
}: {
  linkRef: InternalLinkRef;
  meId?: string;
  onSuppress?: () => void;
}) {
  const context = useSessionsContext();
  const session = linkRef.kind === 'session' ? context?.sessions[linkRef.sessionId] : undefined;
  const channel =
    linkRef.kind === 'channel'
      ? context?.channels.find((candidate) => candidate.id === linkRef.channelId)
      : session
        ? context?.channels.find((candidate) => candidate.id === session.channelId)
        : undefined;
  const now = useNow(Boolean(session && !isTerminalSessionStatus(session.status)));
  const [collapsed, setCollapsed] = useState(false);

  // No requestSession here on purpose: MessageUnfurlCards only renders this card
  // once the session is in the store, so a fetch-on-miss effect could never fire.
  // It owns the request because it can see the whole descriptor list.
  if (linkRef.kind === 'thread' || !channel) return null;

  if (linkRef.kind === 'session') {
    if (!session) return null;
    return (
      <article className="rounded-md border border-edge bg-surface-raised/55 px-3 py-2 text-fg-body">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs text-fg-muted">{harnessLabel(session.harness)}</span>
          <a
            href={internalLinkPath(linkRef)}
            className="min-w-0 truncate font-medium text-fg no-underline hover:underline"
          >
            {session.title}
          </a>
          <GlanceChip session={session} now={now} />
          <CardControls collapsed={collapsed} onCollapsedChange={setCollapsed} onSuppress={onSuppress} />
        </div>
        {collapsed ? null : (
          <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-fg-muted">
            <ChannelRef channel={channel} meId={meId} />
          </div>
        )}
      </article>
    );
  }

  const memberCount = channelMemberCount(channel);
  return (
    <article className="rounded-md border border-edge bg-surface-raised/55 px-3 py-2 text-fg-body">
      <div className="flex min-w-0 items-center gap-2">
        <a
          href={internalLinkPath(linkRef)}
          className="flex min-w-0 items-center gap-1 font-medium text-fg no-underline hover:underline"
        >
          <ChannelRef channel={channel} meId={meId} />
        </a>
        {/* A /members link must not read as a plain channel link. Public channels
            carry no member count (it is private/dm-only on the wire), so without
            this the two cards would be pixel-identical. Native says the same. */}
        {!collapsed && linkRef.membersOpen ? <span className="shrink-0 text-xs text-fg-muted">Members</span> : null}
        {!collapsed && memberCount != null ? (
          <span className="shrink-0 text-xs text-fg-muted">
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </span>
        ) : null}
        <CardControls collapsed={collapsed} onCollapsedChange={setCollapsed} onSuppress={onSuppress} />
      </div>
    </article>
  );
}
