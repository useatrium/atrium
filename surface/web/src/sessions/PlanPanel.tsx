import { memo, useMemo, useState } from 'react';
import type { SessionState, TodoEntry } from '@atrium/centaur-client';
import { ChevronDownIcon, ChevronRightIcon } from '../components/icons';
import { SessionMarkdown } from './Markdown';

type PlanState = NonNullable<SessionState['plan']>;

export const PlanPanel = memo(function PlanPanel({ todos, plan }: { todos?: TodoEntry[]; plan?: PlanState | null }) {
  const [open, setOpen] = useState(false);
  const hasTodos = (todos?.length ?? 0) > 0;
  const hasPlan = plan != null;

  const summary = useMemo(() => {
    if (!hasTodos) return 'Plan';
    const total = todos?.length ?? 0;
    const completed = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
    return `Plan · ${completed}/${total} done`;
  }, [hasTodos, todos]);

  if (!hasTodos && !hasPlan) return null;

  return (
    <section
      data-testid="plan-panel"
      className="mb-3 overflow-hidden rounded-lg border border-edge bg-surface-raised/50"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay/50"
      >
        <span className="text-fg-muted">{open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}</span>
        <span className="min-w-0 flex-1 truncate font-semibold">{summary}</span>
      </button>
      {open && (
        <div className="border-t border-edge px-3.5 py-3">
          {hasTodos && (
            <ul className="space-y-2">
              {todos!.map((todo, index) => (
                <li key={`${index}:${todo.content}`} className="flex min-w-0 items-start gap-2 text-sm leading-relaxed">
                  <TodoStatusIcon status={todo.status} />
                  <span
                    className={`min-w-0 flex-1 break-words ${
                      todo.status === 'completed'
                        ? 'text-fg-muted line-through'
                        : todo.status === 'in_progress'
                          ? 'font-medium text-accent-text'
                          : 'text-fg-body'
                    }`}
                  >
                    {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {plan?.text ? (
            <div className={`max-w-none text-sm text-fg-body ${hasTodos ? 'mt-3 border-t border-edge pt-3' : ''}`}>
              <SessionMarkdown text={plan.text} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
});

function TodoStatusIcon({ status }: { status: TodoEntry['status'] }) {
  if (status === 'completed') {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success-text text-[10px] font-bold leading-none text-surface"
      >
        ✓
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span
        aria-hidden="true"
        className="mt-1 h-3 w-3 shrink-0 rounded-full border border-accent-text bg-accent-text shadow-[0_0_0_3px_var(--color-accent-tint)]"
      />
    );
  }
  return (
    <span aria-hidden="true" className="mt-1 h-3 w-3 shrink-0 rounded-full border border-edge-strong bg-surface" />
  );
}
