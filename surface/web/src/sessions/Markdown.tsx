import { Component, memo, useMemo, type ReactNode } from 'react';
import { parseAgentPathHref } from '@atrium/surface-client/agent-paths';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { FilePathChip } from '../components/FilePathChip';
import './Markdown.css';

function plainTextFallback(text: string) {
  return <div className="whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-fg-body">{text}</div>;
}

class MarkdownBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { hasError: boolean; resetKey: string }
> {
  state = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { hasError: boolean; resetKey: string }) {
    if (props.resetKey !== state.resetKey) return { hasError: false, resetKey: props.resetKey };
    return null;
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function componentsFor(channelId?: string | null, sessionId?: string | null): Components {
  return {
    h1: ({ children, node: _node, ...props }) => (
      <h1 className="mb-2 mt-3 text-lg font-semibold leading-snug text-fg" {...props}>
        {children}
      </h1>
    ),
    h2: ({ children, node: _node, ...props }) => (
      <h2 className="mb-1.5 mt-3 text-base font-semibold leading-snug text-fg" {...props}>
        {children}
      </h2>
    ),
    h3: ({ children, node: _node, ...props }) => (
      <h3 className="mb-1 mt-2.5 text-sm font-semibold leading-snug text-fg" {...props}>
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
    p: ({ children, node: _node, ...props }) => (
      <p className="my-1 break-words text-sm leading-relaxed text-fg-body" {...props}>
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
      const refInfo = href ? parseAgentPathHref(href) : null;
      if (refInfo) return <FilePathChip refInfo={refInfo} channelId={channelId} sessionId={sessionId} />;
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
    ul: ({ children, node: _node, ...props }) => (
      <ul className="my-1.5 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-fg-body" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, node: _node, ...props }) => (
      <ol className="my-1.5 list-decimal space-y-0.5 pl-5 text-sm leading-relaxed text-fg-body" {...props}>
        {children}
      </ol>
    ),
    li: ({ children, className, node: _node, ...props }) => (
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
    pre: ({ children, node: _node, ...props }) => (
      <pre
        className="my-2 overflow-x-auto rounded-md border border-edge bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-fg-body"
        {...props}
      >
        {children}
      </pre>
    ),
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

export const SessionMarkdown = memo(function SessionMarkdown({
  text,
  sessionId,
  channelId,
}: {
  text: string;
  sessionId?: string | null;
  channelId?: string | null;
}) {
  const components = useMemo(() => componentsFor(channelId, sessionId), [channelId, sessionId]);
  return (
    <MarkdownBoundary fallback={plainTextFallback(text)} resetKey={text}>
      <div className="atrium-session-markdown break-words py-1 text-sm leading-relaxed text-fg-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
          {text}
        </ReactMarkdown>
      </div>
    </MarkdownBoundary>
  );
});
