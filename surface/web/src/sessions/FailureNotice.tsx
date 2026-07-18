import type { FailureInfo } from '@atrium/centaur-client';

export function FailureNotice({ info }: { info: FailureInfo }) {
  return (
    <article data-testid="failure-notice" className="rounded-md border border-edge bg-surface-raised px-3 py-2">
      <div className="flex items-baseline gap-1.5 text-xs text-danger-text">
        <span aria-hidden="true">⚠</span>
        <strong>{info.label}</strong>
      </div>
      <p className="mt-0.5 text-xs text-fg-body">{info.summary}</p>
      {info.detail && (
        <details className="mt-1.5 text-2xs text-fg-muted">
          <summary className="cursor-pointer hover:text-fg-body">details</summary>
          <div className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-fg-muted">{info.detail}</div>
        </details>
      )}
    </article>
  );
}
