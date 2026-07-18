import { fileChangeFromToolCall, type TurnWorkItem } from '@atrium/centaur-client';
import { InlineFileChange } from './fileChangeView';
import { SessionMarkdown } from './Markdown';

function StepActions({ onOpenWork, onDiscuss }: { onOpenWork?: () => void; onDiscuss?: () => void }) {
  if (!onOpenWork && !onDiscuss) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
      {onDiscuss && (
        <button type="button" onClick={onDiscuss} className="text-xs font-medium text-accent-text hover:underline">
          Discuss in thread
        </button>
      )}
      {onOpenWork && (
        <button type="button" onClick={onOpenWork} className="text-xs font-medium text-accent-text hover:underline">
          full output → What it ran
        </button>
      )}
    </div>
  );
}

export function StepDetail({
  item,
  onOpenWork,
  onDiscuss,
}: {
  item: TurnWorkItem;
  onOpenWork?: () => void;
  onDiscuss?: () => void;
}) {
  if (item.type === 'tool_call') {
    const fileChange = fileChangeFromToolCall(item);
    if (fileChange) {
      const status = item.result === undefined ? 'running' : item.result.is_error ? 'error' : 'done';
      return (
        <div data-testid={`step-detail-${item.id}`} className="ml-6 mt-1">
          <InlineFileChange change={fileChange} status={status} />
          <StepActions onOpenWork={onOpenWork} onDiscuss={onDiscuss} />
        </div>
      );
    }

    const hasCommand = typeof item.input.command === 'string';
    const rest = Object.fromEntries(Object.entries(item.input).filter(([key]) => key !== 'command'));
    const argumentsJson = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
    const resultContent = item.result?.content.trim() ? item.result.content : null;
    return (
      <div data-testid={`step-detail-${item.id}`} className="ml-6 mt-1 rounded-md border border-edge bg-surface/70 p-2">
        {argumentsJson && (
          <pre className="mt-1 max-h-48 overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-4 text-fg-muted">
            {argumentsJson}
          </pre>
        )}
        {item.result && resultContent && (
          <pre
            className={`mt-1.5 max-h-48 overflow-hidden whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-xs leading-4 ${
              item.result.is_error
                ? 'border-danger-border bg-danger-tint text-danger-text-strong'
                : 'border-edge bg-surface text-fg-secondary'
            }`}
          >
            {resultContent}
          </pre>
        )}
        {!hasCommand && !argumentsJson && !resultContent && (
          <span className="text-xs text-fg-muted">No detail recorded.</span>
        )}
        <StepActions onOpenWork={onOpenWork} onDiscuss={onDiscuss} />
      </div>
    );
  }

  return (
    <div data-testid={`step-detail-${item.id}`} className="ml-6 mt-1 rounded-md border border-edge bg-surface/70 p-2">
      <SessionMarkdown text={item.text || item.summary || 'No detail recorded.'} />
      <StepActions onOpenWork={onOpenWork} onDiscuss={onDiscuss} />
    </div>
  );
}
