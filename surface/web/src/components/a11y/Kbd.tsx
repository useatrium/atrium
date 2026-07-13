import { formatChord, type Chord } from '../../lib/shortcuts';

/**
 * Renders a keyboard chord as one or more keycaps (e.g. ⌘ K).
 * Purely presentational: pass `decorative` when the chord is announced
 * elsewhere (e.g. inside a tooltip whose label already describes the action)
 * so screen readers don't read the raw symbols.
 */
export function Kbd({ keys, className, decorative }: { keys: Chord; className?: string; decorative?: boolean }) {
  const parts = formatChord(keys);
  return (
    <span aria-hidden={decorative ? true : undefined} className={`inline-flex items-center gap-0.5 ${className ?? ''}`}>
      {parts.map((part, i) => (
        <kbd
          key={`${part}-${i}`}
          className="min-w-[1.25rem] rounded border border-edge-strong bg-surface-raised px-1 py-px text-center text-3xs font-medium leading-[1.1rem] text-fg-muted"
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}
