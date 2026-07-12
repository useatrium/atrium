import type { ReactNode } from 'react';

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-xs">
        {icon && (
          <div className="mx-auto mb-3 grid size-9 place-items-center rounded-md border border-edge bg-surface-raised/60 text-fg-muted">
            {icon}
          </div>
        )}
        <div className="text-sm font-semibold text-fg">{title}</div>
        {hint && <div className="mt-1 text-xs leading-5 text-fg-muted">{hint}</div>}
      </div>
    </div>
  );
}
