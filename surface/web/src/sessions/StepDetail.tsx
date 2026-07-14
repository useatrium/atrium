import type { TurnWorkItem } from '@atrium/centaur-client';

function toolDetail(item: Extract<TurnWorkItem, { type: 'tool_call' }>): string {
  const args = JSON.stringify(item.input, null, 2);
  if (!item.result) return `Arguments\n${args}`;
  return `Arguments\n${args}\n\nOutput\n${item.result.content}`;
}

export function StepDetail({ item, onOpenWork }: { item: TurnWorkItem; onOpenWork?: () => void }) {
  const detail = item.type === 'reasoning' ? item.text : toolDetail(item);

  return (
    <div data-testid={`step-detail-${item.id}`} className="ml-6 mt-1 rounded-md border border-edge bg-surface/70 p-2">
      <pre className="max-h-48 overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-4 text-fg-secondary">
        {detail || 'No detail recorded.'}
      </pre>
      {onOpenWork && (
        <button
          type="button"
          onClick={onOpenWork}
          className="mt-1 text-xs font-medium text-accent-text hover:underline"
        >
          full output → What it ran
        </button>
      )}
    </div>
  );
}
