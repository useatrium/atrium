import { isValidElement, memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { compactMarkdownSource, isUnfurlableUrl, type UnfurlResult } from '@atrium/surface-client';
import { parseAgentPathHref } from '@atrium/surface-client/agent-paths';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import {
  extractEntryHandles,
  findEntryLinkCandidates,
  resolveEntryQuote,
  type ResolvedEntryQuote,
} from '../lib/entryLinks';
import { resolveUnfurls } from '../lib/unfurls';
import { api } from '../api';
import { EntryInlineChip, EntryQuoteCard } from './EntryQuoteCard';
import { FilePathChip } from './FilePathChip';
import { LinkUnfurlCard } from './LinkUnfurlCard';
import { TimelineImage } from './TimelineImage';
import '../sessions/Markdown.css';
import { useUserDirectory } from '../userDirectory';
import { parseInAppRoute, useLocation } from '../router';

type MarkdownMode = 'message' | 'compact';

const MENTION_URL_PREFIX = 'atrium-mention:';
const MENTION_ID_URL_PREFIX = 'atrium-mention-id:';
const SPECIAL_MENTION_URL_PREFIX = 'atrium-special-mention:';
const ENTRY_URL_PREFIX = 'atrium-entry:';
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MENTION_RE = new RegExp(`<@(${UUID_SOURCE})>|<!(channel|here)>|(^|[\\s(["'{<])@([a-z0-9][a-z0-9_-]{1,31})`, 'gi');
const COLLAPSE_LINE_THRESHOLD = 16;
const COLLAPSE_CHAR_THRESHOLD = 1800;
const MAX_VISIBLE_UNFURL_CARDS = 3;

function remarkMentions() {
  return (tree: unknown) => {
    visitChildren(tree, (node, parent) => {
      if (!node || typeof node.value !== 'string') return null;
      if (node.type === 'html') {
        // A line starting with <!channel>/<!here> parses as an HTML block whose
        // value spans the whole line (react-markdown drops raw HTML nodes), so
        // re-tokenize the block instead of matching the bare token only. Block
        // positions need a paragraph wrapper so the pieces stay on one line.
        if (!/<!(channel|here)>/i.test(node.value)) return null;
        const pieces = splitMentionText(node.value);
        return parent.type === 'root' ? [{ type: 'paragraph', children: pieces }] : pieces;
      }
      if (node.type !== 'text') return null;
      const pieces = splitMentionText(node.value);
      return pieces.some((piece) => piece.type === 'link') ? pieces : null;
    });
  };
}

function remarkEntryRefs() {
  return (tree: unknown) => {
    visitChildren(tree, (node) => {
      if (!node) return null;
      if (node.type === 'link') {
        const handle = typeof node.url === 'string' ? findEntryLinkCandidates(node.url)[0]?.handle : null;
        if (handle) {
          node.url = `${ENTRY_URL_PREFIX}${handle}`;
          node.title = null;
        }
        return [node];
      }
      if (node.type !== 'text' || typeof node.value !== 'string') return null;
      const pieces = splitEntryRefText(node.value);
      // Replace whenever a ref was found — including a node whose entire text is a
      // single ref (e.g. a list item / heading / table cell), which yields one link piece.
      return pieces.some((piece) => piece.type === 'link') ? pieces : null;
    });
  };
}

type MutableNode = {
  type?: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MutableNode[];
};

function visitChildren(node: unknown, replace: (node: MutableNode, parent: MutableNode) => MutableNode[] | null): void {
  const parent = node as MutableNode;
  if (!Array.isArray(parent.children)) return;
  const next: MutableNode[] = [];
  for (const child of parent.children) {
    const replacement = replace(child, parent);
    if (replacement) next.push(...replacement);
    else {
      visitChildren(child, replace);
      next.push(child);
    }
  }
  parent.children = next;
}

function splitMentionText(text: string): MutableNode[] {
  const out: MutableNode[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  for (let match = MENTION_RE.exec(text); match; match = MENTION_RE.exec(text)) {
    const userId = match[1];
    const special = match[2];
    const boundary = match[3] ?? '';
    const handle = match[4];
    const mentionStart = match.index + boundary.length;
    if (mentionStart > last) out.push({ type: 'text', value: text.slice(last, mentionStart) });
    out.push({
      type: 'link',
      url: userId
        ? `${MENTION_ID_URL_PREFIX}${userId}`
        : special
          ? `${SPECIAL_MENTION_URL_PREFIX}${special.toLowerCase()}`
          : `${MENTION_URL_PREFIX}${handle ?? ''}`,
      title: null,
      children: [{ type: 'text', value: userId ? `<@${userId}>` : `@${special ?? handle ?? ''}` }],
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

function splitEntryRefText(text: string): MutableNode[] {
  const out: MutableNode[] = [];
  let last = 0;

  for (const match of findEntryLinkCandidates(text)) {
    if (!match.handle) continue;
    if (match.index > last) out.push({ type: 'text', value: text.slice(last, match.index) });
    out.push({
      type: 'link',
      url: `${ENTRY_URL_PREFIX}${match.handle}`,
      title: null,
      children: [{ type: 'text', value: match.candidate }],
    });
    if (match.trailing) out.push({ type: 'text', value: match.trailing });
    last = match.index + match.original.length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out.length > 0 ? out : [{ type: 'text', value: text }];
}

function safeUrlTransform(url: string) {
  if (url.startsWith(MENTION_URL_PREFIX)) return url;
  if (url.startsWith(MENTION_ID_URL_PREFIX)) return url;
  if (url.startsWith(SPECIAL_MENTION_URL_PREFIX)) return url;
  if (url.startsWith(ENTRY_URL_PREFIX)) return url;
  return defaultUrlTransform(url);
}

function markdownImageDimension(value: number | string | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function standaloneEntryHandle(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const matches = findEntryLinkCandidates(trimmed);
  if (matches.length !== 1) return null;
  const [match] = matches;
  if (!match || match.index !== 0 || match.original.length !== trimmed.length) return null;
  return match.handle;
}

function partitionEntryLinks(text: string): { bodyText: string; standaloneHandles: string[] } {
  const bodyLines: string[] = [];
  const standaloneHandles: string[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r\n|\r|\n/)) {
    const handle = standaloneEntryHandle(line);
    if (handle) {
      if (!seen.has(handle)) {
        seen.add(handle);
        standaloneHandles.push(handle);
      }
      continue;
    }
    bodyLines.push(line);
  }

  return { bodyText: bodyLines.join('\n'), standaloneHandles };
}

function hasEntryLinkPath(url: string): boolean {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[0] === 'e';
  } catch {
    return false;
  }
}

export function extractExternalUnfurlUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const match of findEntryLinkCandidates(text)) {
    if (match.handle || !isUnfurlableUrl(match.candidate) || hasEntryLinkPath(match.candidate)) continue;
    if (seen.has(match.candidate)) continue;
    seen.add(match.candidate);
    urls.push(match.candidate);
  }

  return urls;
}

function mentionSpan(handle: string, meHandle?: string) {
  const isMe = meHandle != null && handle.toLowerCase() === meHandle.toLowerCase();
  return (
    <span
      className={
        isMe
          ? 'rounded bg-warning-hover/20 px-0.5 font-medium text-warning-text'
          : 'rounded bg-accent-hover/10 px-0.5 text-accent-text-strong'
      }
    >
      @{handle}
    </span>
  );
}

function mentionIdSpan(
  userId: string,
  resolve: (id: string) => { displayName: string } | null,
  meId: string | undefined,
  compact: boolean,
) {
  const user = resolve(userId);
  const isMe = meId != null && userId.toLowerCase() === meId.toLowerCase();
  const label = user?.displayName ?? (compact ? 'someone' : 'unknown');
  return (
    <span
      className={
        isMe
          ? 'rounded bg-warning-hover/20 px-0.5 font-medium text-warning-text'
          : user
            ? 'rounded bg-accent-hover/10 px-0.5 text-accent-text-strong'
            : 'rounded bg-surface-overlay px-0.5 text-fg-muted'
      }
    >
      @{label}
    </span>
  );
}

function specialMentionSpan(name: string) {
  return (
    <span className="rounded bg-warning-tint/30 px-0.5 font-medium text-warning-text ring-1 ring-inset ring-warning-border/40">
      @{name}
    </span>
  );
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <span aria-hidden="true" className="text-3xs font-bold leading-none">
        OK
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="relative h-3.5 w-3.5 text-current">
      <span className="absolute left-1 top-1 h-2.5 w-2.5 rounded-[2px] border border-current" />
      <span className="absolute left-0 top-0 h-2.5 w-2.5 rounded-[2px] border border-current bg-surface" />
    </span>
  );
}

function CopyablePre({ children, ...props }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = nodeText(children).replace(/\n$/, '');

  const copyCode = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText || !code) return;
    void clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="group relative my-2">
      <pre
        className="overflow-x-auto rounded-md border border-edge bg-surface px-3 py-2 pr-11 font-mono text-xs leading-relaxed text-fg-body"
        {...props}
      >
        {children}
      </pre>
      <button
        type="button"
        aria-label={copied ? 'Copied code' : 'Copy code'}
        title={copied ? 'Copied code' : 'Copy code'}
        onClick={(event) => {
          event.stopPropagation();
          copyCode();
        }}
        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded border border-edge bg-surface-raised/95 text-fg-muted shadow-sm transition hover:border-edge-strong hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <CopyIcon copied={copied} />
      </button>
    </div>
  );
}

function componentsFor(
  mode: MarkdownMode,
  meHandle: string | undefined,
  meId: string | undefined,
  resolveUser: (id: string) => { displayName: string } | null,
  channelId: string | null,
  sessionId: string | null,
): Components {
  const compact = mode === 'compact';
  return {
    h1: ({ children, node: _node, ...props }) => (
      <h3 className="mb-1 mt-2 text-sm font-semibold leading-snug text-fg" {...props}>
        {children}
      </h3>
    ),
    h2: ({ children, node: _node, ...props }) => (
      <h3 className="mb-1 mt-2 text-sm font-semibold leading-snug text-fg" {...props}>
        {children}
      </h3>
    ),
    h3: ({ children, node: _node, ...props }) => (
      <h3 className="mb-1 mt-2 text-sm font-semibold leading-snug text-fg" {...props}>
        {children}
      </h3>
    ),
    h4: ({ children, node: _node, ...props }) => (
      <h4 className="mb-1 mt-2 text-sm font-semibold leading-snug text-fg-secondary" {...props}>
        {children}
      </h4>
    ),
    h5: ({ children, node: _node, ...props }) => (
      <h5 className="mb-1 mt-2 text-xs font-semibold uppercase leading-snug text-fg-secondary" {...props}>
        {children}
      </h5>
    ),
    h6: ({ children, node: _node, ...props }) => (
      <h6 className="mb-1 mt-2 text-2xs font-semibold uppercase leading-snug text-fg-muted" {...props}>
        {children}
      </h6>
    ),
    p: ({ children, node: _node, ...props }) =>
      compact ? (
        <span {...props}>{children}</span>
      ) : (
        <p className="my-1 break-words text-sm leading-relaxed text-fg-body first:mt-0 last:mb-0" {...props}>
          {children}
        </p>
      ),
    strong: ({ children, node: _node, ...props }) => (
      <strong className="font-semibold text-fg" {...props}>
        {children}
      </strong>
    ),
    em: ({ children, node: _node, ...props }) => (
      <em className="italic text-fg-body" {...props}>
        {children}
      </em>
    ),
    a: ({ children, href, node: _node, ...props }) => {
      if (href?.startsWith(MENTION_URL_PREFIX)) {
        return mentionSpan(href.slice(MENTION_URL_PREFIX.length), meHandle);
      }
      if (href?.startsWith(MENTION_ID_URL_PREFIX)) {
        return mentionIdSpan(href.slice(MENTION_ID_URL_PREFIX.length), resolveUser, meId, compact);
      }
      if (href?.startsWith(SPECIAL_MENTION_URL_PREFIX)) {
        return specialMentionSpan(href.slice(SPECIAL_MENTION_URL_PREFIX.length));
      }
      if (href?.startsWith(ENTRY_URL_PREFIX)) {
        return <EntryInlineChip handle={href.slice(ENTRY_URL_PREFIX.length)} compact={compact} />;
      }
      const refInfo = href ? parseAgentPathHref(href) : null;
      if (refInfo) {
        return <FilePathChip refInfo={refInfo} channelId={channelId} sessionId={sessionId} compact={compact} />;
      }
      if (compact) {
        return (
          <span className="text-accent-text" {...props}>
            {children}
          </span>
        );
      }
      return (
        <a
          className="text-accent-text underline decoration-accent-text/50 underline-offset-2 hover:text-accent-text-strong"
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          {...props}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt, title, width, height, node: _node }) => {
      if (!src) return null;
      return (
        <TimelineImage
          src={src}
          alt={alt ?? ''}
          title={title}
          width={markdownImageDimension(width)}
          height={markdownImageDimension(height)}
          loading="lazy"
          className="my-2 max-h-72 rounded-md border border-edge object-contain"
        />
      );
    },
    ul: ({ children, node: _node, ...props }) =>
      compact ? (
        <span {...props}>{children}</span>
      ) : (
        <ul className="my-1.5 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-fg-body" {...props}>
          {children}
        </ul>
      ),
    ol: ({ children, node: _node, ...props }) =>
      compact ? (
        <span {...props}>{children}</span>
      ) : (
        <ol className="my-1.5 list-decimal space-y-0.5 pl-5 text-sm leading-relaxed text-fg-body" {...props}>
          {children}
        </ol>
      ),
    li: ({ children, className, node: _node, ...props }) =>
      compact ? (
        <span className={className} {...props}>
          {children}
        </span>
      ) : (
        <li
          className={`${className ?? ''} break-words pl-1 marker:text-fg-muted [&>input:first-child]:mr-1.5 [&>input:first-child]:align-[-1px]`}
          {...props}
        >
          {children}
        </li>
      ),
    blockquote: ({ children, node: _node, ...props }) => (
      <blockquote className="my-2 border-l-2 border-edge-strong pl-3 text-fg-secondary" {...props}>
        {children}
      </blockquote>
    ),
    hr: ({ node: _node, ...props }) => <hr className="my-3 border-edge" {...props} />,
    code: ({ children, className, node: _node, ...props }) => {
      if (className?.includes('hljs')) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      return (
        <code className="rounded bg-surface-overlay/70 px-1 py-0.5 font-mono text-[0.8125em] text-code" {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children, node: _node, ...props }) => <CopyablePre {...props}>{children}</CopyablePre>,
    table: ({ children, node: _node, ...props }) => (
      <div className="my-2 overflow-x-auto rounded-md border border-edge">
        <table className="min-w-full border-collapse text-left text-xs leading-relaxed text-fg-body" {...props}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, node: _node, ...props }) => (
      <th className="border-b border-edge bg-surface-raised/60 px-2 py-1 font-semibold text-fg" {...props}>
        {children}
      </th>
    ),
    td: ({ children, node: _node, ...props }) => (
      <td className="border-b border-edge px-2 py-1 align-top text-fg-body last:border-r-0" {...props}>
        {children}
      </td>
    ),
  };
}

function MarkdownContent({
  text,
  mode,
  meHandle,
  meId,
  channelId,
  sessionId,
}: {
  text: string;
  mode: MarkdownMode;
  meHandle?: string;
  meId?: string;
  channelId?: string | null;
  sessionId?: string | null;
}) {
  const source = mode === 'compact' ? compactMarkdownSource(text) : text;
  const { resolve } = useUserDirectory(text);
  const location = useLocation();
  const route = useMemo(() => parseInAppRoute(location.pathname), [location.pathname]);
  const effectiveChannelId = channelId ?? route?.channelId ?? null;
  const effectiveSessionId = sessionId ?? route?.sessionId ?? null;
  const components = useMemo(
    () => componentsFor(mode, meHandle, meId, resolve, effectiveChannelId, effectiveSessionId),
    [effectiveChannelId, effectiveSessionId, meHandle, meId, mode, resolve],
  );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMentions, remarkEntryRefs]}
      rehypePlugins={mode === 'message' ? [rehypeHighlight] : []}
      components={components}
      skipHtml
      urlTransform={safeUrlTransform}
    >
      {source}
    </ReactMarkdown>
  );
}

export const CompactMarkdownText = memo(function CompactMarkdownText({
  text,
  meHandle,
  meId,
}: {
  text: string;
  meHandle?: string;
  meId?: string;
}) {
  return (
    <span className="min-w-0 truncate">
      <MarkdownContent text={text} mode="compact" meHandle={meHandle} meId={meId} />
    </span>
  );
});

export interface MessageUnfurlOptions {
  messageEventId: number | null;
  suppressed: string[];
  canManage: boolean;
}

type UnfurlCardDescriptor = { kind: 'entry'; handle: string } | { kind: 'link'; url: string };

function MessageUnfurlCards({
  descriptors,
  messageEventId,
  canManage = false,
  onSuppress,
}: {
  descriptors: UnfurlCardDescriptor[];
  messageEventId?: number | null;
  canManage?: boolean;
  onSuppress?: (key: string) => void;
}) {
  const handles = descriptors
    .filter((item): item is Extract<UnfurlCardDescriptor, { kind: 'entry' }> => item.kind === 'entry')
    .map((item) => item.handle);
  const urls = descriptors
    .filter((item): item is Extract<UnfurlCardDescriptor, { kind: 'link' }> => item.kind === 'link')
    .map((item) => item.url);
  const [entries, setEntries] = useState<Record<string, ResolvedEntryQuote | null>>({});
  const [links, setLinks] = useState<Record<string, UnfurlResult | null>>({});
  const [showAll, setShowAll] = useState(false);
  const handlesKey = handles.join('\n');
  const urlsKey = urls.join('\n');

  useEffect(() => {
    let active = true;
    if (handles.length === 0) return undefined;
    void Promise.all(handles.map(async (handle) => [handle, await resolveEntryQuote(handle)] as const)).then(
      (resolved) => {
        if (active) setEntries((current) => ({ ...current, ...Object.fromEntries(resolved) }));
      },
    );
    return () => {
      active = false;
    };
  }, [handlesKey]);

  useEffect(() => {
    let active = true;
    if (urls.length === 0) return undefined;
    void resolveUnfurls(urls).then((resolved) => {
      if (active) setLinks((current) => ({ ...current, ...resolved }));
    });
    return () => {
      active = false;
    };
  }, [urlsKey]);

  const resolvedDescriptors = descriptors.filter((item) =>
    item.kind === 'entry' ? Boolean(entries[item.handle]) : Boolean(links[item.url]),
  );
  const visible = showAll ? resolvedDescriptors : resolvedDescriptors.slice(0, MAX_VISIBLE_UNFURL_CARDS);

  if (resolvedDescriptors.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1.5 whitespace-normal">
      {visible.map((item) => {
        if (item.kind === 'entry') {
          const entry = entries[item.handle];
          return entry ? (
            <EntryQuoteCard
              key={`entry:${item.handle}`}
              entry={entry}
              messageEventId={messageEventId}
              onSuppress={canManage && onSuppress ? () => onSuppress(item.handle) : undefined}
            />
          ) : null;
        }
        const result = links[item.url];
        return result ? (
          <LinkUnfurlCard
            key={`link:${item.url}`}
            result={result}
            messageEventId={messageEventId}
            onSuppress={canManage && onSuppress ? () => onSuppress(item.url) : undefined}
          />
        ) : null;
      })}
      {resolvedDescriptors.length > MAX_VISIBLE_UNFURL_CARDS ? (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="self-start text-xs font-medium text-accent-text hover:underline"
        >
          {showAll ? 'Show fewer' : `Show ${resolvedDescriptors.length - MAX_VISIBLE_UNFURL_CARDS} more`}
        </button>
      ) : null}
    </div>
  );
}

export function MessageText({
  text,
  meHandle,
  meId,
  unfurls,
  channelId,
  sessionId,
  collapsible = true,
}: {
  text: string;
  meHandle?: string;
  meId?: string;
  unfurls?: MessageUnfurlOptions;
  channelId?: string | null;
  sessionId?: string | null;
  /** Opt out when an ancestor owns the clamp. Nesting this component's own
   *  max-height inside a line-clamp lets the outer clamp only bite once the
   *  inner one is released — which made "Show more" visibly SHRINK the text. */
  collapsible?: boolean;
}) {
  const { bodyText } = partitionEntryLinks(text);
  const allHandles = extractEntryHandles(text);
  const allUrls = extractExternalUnfurlUrls(text);
  const [optimisticallySuppressed, setOptimisticallySuppressed] = useState<Set<string>>(() => new Set());
  const [unfurlError, setUnfurlError] = useState(false);
  const suppressed = new Set(unfurls?.suppressed ?? []);
  for (const handle of optimisticallySuppressed) suppressed.add(handle);
  const cardDescriptors: UnfurlCardDescriptor[] = [
    ...allHandles
      .filter((handle) => !suppressed.has(handle))
      .map((handle): UnfurlCardDescriptor => ({ kind: 'entry', handle })),
    ...allUrls.filter((url) => !suppressed.has(url)).map((url): UnfurlCardDescriptor => ({ kind: 'link', url })),
  ];
  const shouldCollapse =
    collapsible &&
    (bodyText.length > COLLAPSE_CHAR_THRESHOLD || bodyText.split(/\r\n|\r|\n/).length > COLLAPSE_LINE_THRESHOLD);
  const [expanded, setExpanded] = useState(!shouldCollapse);
  const content: ReactNode = (
    <MarkdownContent
      text={bodyText}
      mode="message"
      meHandle={meHandle}
      meId={meId}
      channelId={channelId}
      sessionId={sessionId}
    />
  );

  return (
    <>
      <div
        className={
          shouldCollapse && !expanded
            ? 'relative max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
            : undefined
        }
      >
        {content}
      </div>
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs font-medium text-accent-text hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <MessageUnfurlCards
        descriptors={cardDescriptors}
        messageEventId={unfurls?.messageEventId}
        canManage={unfurls?.canManage}
        onSuppress={
          unfurls?.canManage && unfurls.messageEventId != null
            ? (key) => {
                const next = new Set(unfurls.suppressed);
                for (const hidden of optimisticallySuppressed) next.add(hidden);
                next.add(key);
                setOptimisticallySuppressed(next);
                setUnfurlError(false);
                void api.suppressMessageUnfurls(unfurls.messageEventId!, [...next]).catch(() => {
                  setOptimisticallySuppressed((current) => {
                    const restored = new Set(current);
                    restored.delete(key);
                    return restored;
                  });
                  setUnfurlError(true);
                });
              }
            : undefined
        }
      />
      {unfurlError ? <div className="mt-1 text-xs text-danger">Couldn't remove preview — try again.</div> : null}
    </>
  );
}
