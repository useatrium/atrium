import { isValidElement, memo, useMemo, useState, type ReactNode } from 'react';
import { compactMarkdownSource } from '@atrium/surface-client';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { findEntryLinkCandidates } from '../lib/entryLinks';
import { EntryInlineChip, EntryQuoteCards } from './EntryQuoteCard';
import { TimelineImage } from './TimelineImage';
import '../sessions/Markdown.css';

type MarkdownMode = 'message' | 'compact';

const MENTION_URL_PREFIX = 'atrium-mention:';
const ENTRY_URL_PREFIX = 'atrium-entry:';
const MENTION_RE = /@([a-z0-9][a-z0-9_-]{1,31})/gi;
const COLLAPSE_LINE_THRESHOLD = 16;
const COLLAPSE_CHAR_THRESHOLD = 1800;

function remarkMentions() {
  return (tree: unknown) => {
    visitChildren(tree, (node) => {
      if (!node || node.type !== 'text' || typeof node.value !== 'string') return null;
      const pieces = splitMentionText(node.value);
      return pieces.length > 1 ? pieces : null;
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

function visitChildren(node: unknown, replace: (node: MutableNode) => MutableNode[] | null): void {
  const parent = node as MutableNode;
  if (!Array.isArray(parent.children)) return;
  const next: MutableNode[] = [];
  for (const child of parent.children) {
    const replacement = replace(child);
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
    const handle = match[1] ?? '';
    if (match.index > last) out.push({ type: 'text', value: text.slice(last, match.index) });
    out.push({
      type: 'link',
      url: `${MENTION_URL_PREFIX}${handle}`,
      title: null,
      children: [{ type: 'text', value: `@${handle}` }],
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

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <span aria-hidden="true" className="text-[10px] font-bold leading-none">
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

function componentsFor(mode: MarkdownMode, meHandle?: string): Components {
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
      if (href?.startsWith(ENTRY_URL_PREFIX)) {
        return <EntryInlineChip handle={href.slice(ENTRY_URL_PREFIX.length)} compact={compact} />;
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

function MarkdownContent({ text, mode, meHandle }: { text: string; mode: MarkdownMode; meHandle?: string }) {
  const source = mode === 'compact' ? compactMarkdownSource(text) : text;
  const components = useMemo(() => componentsFor(mode, meHandle), [mode, meHandle]);
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
}: {
  text: string;
  meHandle?: string;
}) {
  return (
    <span className="min-w-0 truncate">
      <MarkdownContent text={text} mode="compact" meHandle={meHandle} />
    </span>
  );
});

export function MessageText({ text, meHandle }: { text: string; meHandle?: string }) {
  const { bodyText, standaloneHandles } = partitionEntryLinks(text);
  const shouldCollapse =
    bodyText.length > COLLAPSE_CHAR_THRESHOLD || bodyText.split(/\r\n|\r|\n/).length > COLLAPSE_LINE_THRESHOLD;
  const [expanded, setExpanded] = useState(!shouldCollapse);
  const content: ReactNode = <MarkdownContent text={bodyText} mode="message" meHandle={meHandle} />;

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
      <EntryQuoteCards handles={standaloneHandles.slice(0, 3)} />
    </>
  );
}
