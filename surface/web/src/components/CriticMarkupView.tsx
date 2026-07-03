import type { CriticBlock, CriticSegment } from '@atrium/surface-client';
import { parseCriticMarkup } from '@atrium/surface-client';

import './CriticMarkupView.css';

function SegmentView({ segment }: { segment: CriticSegment }) {
  if (segment.kind === 'text') return <>{segment.text}</>;
  if (segment.kind === 'del') return <span className="atrium-critic-view-del">{segment.text}</span>;
  if (segment.kind === 'ins') return <span className="atrium-critic-view-ins">{segment.text}</span>;
  if (segment.kind === 'sub') {
    return (
      <>
        <span className="atrium-critic-view-del">{segment.del}</span>
        <span className="atrium-critic-view-ins">{segment.ins}</span>
      </>
    );
  }
  if (segment.kind === 'highlight') {
    return (
      <>
        <span className="atrium-critic-view-highlight">{segment.text}</span>
        <span className="atrium-critic-view-comment-bubble">{segment.comment}</span>
      </>
    );
  }
  return <span className="atrium-critic-view-note-chip">{segment.comment}</span>;
}

function fenceLanguage(fence: string): string | null {
  const language = fence.replace(/^`+/, '').trim();
  return language || null;
}

function BlockView({ block, index }: { block: CriticBlock; index: number }) {
  if (block.type === 'prose') {
    return (
      <div className="atrium-critic-view-block atrium-critic-view-prose">
        {block.segments.map((segment, segmentIndex) => (
          <SegmentView key={`${index}-${segmentIndex}`} segment={segment} />
        ))}
      </div>
    );
  }

  if (block.type === 'code') {
    const language = fenceLanguage(block.fence);
    return (
      <pre className="atrium-critic-view-code">
        <code className={language ? `language-${language}` : undefined}>{block.content}</code>
      </pre>
    );
  }

  if (block.type === 'commented-code') {
    const language = fenceLanguage(block.fence);
    return (
      <div className="atrium-critic-view-block atrium-critic-view-commented-code">
        <pre className="atrium-critic-view-code">
          <code className={language ? `language-${language}` : undefined}>{block.content}</code>
        </pre>
        <span className="atrium-critic-view-note-chip">{block.comment}</span>
      </div>
    );
  }

  return (
    <div className="atrium-critic-view-separator" aria-label="omitted content">
      ⋯
    </div>
  );
}

export function CriticMarkupView({
  text,
  blocks,
  className,
}: {
  text?: string;
  blocks?: CriticBlock[];
  className?: string;
}) {
  const parsedBlocks = blocks ?? parseCriticMarkup(text ?? '');
  return (
    <div className={className ? `atrium-critic-view ${className}` : 'atrium-critic-view'}>
      {parsedBlocks.map((block, index) => (
        <BlockView key={index} block={block} index={index} />
      ))}
    </div>
  );
}
