import type { MentionCandidate } from '@atrium/surface-client';
import { Avatar } from './Avatar';

export function MentionSuggestions({
  activeIndex,
  candidates,
  listboxId,
  optionId,
  onActiveIndexChange,
  onInsert,
}: {
  activeIndex: number;
  candidates: MentionCandidate[];
  listboxId: string;
  optionId: (index: number) => string;
  onActiveIndexChange: (index: number) => void;
  onInsert: (candidate: MentionCandidate) => void;
}) {
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label="Mention suggestions"
      className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-edge-strong bg-surface-raised p-1 shadow-lg"
    >
      {candidates.map((candidate, index) => {
        const special = candidate.kind === 'special';
        const firstSpecial = special && candidates[index - 1]?.kind !== 'special';
        return (
          <div
            key={special ? candidate.name : candidate.user.id}
            id={optionId(index)}
            role="option"
            tabIndex={-1}
            aria-selected={index === activeIndex}
            onMouseEnter={() => onActiveIndexChange(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onInsert(candidate);
            }}
            className={`flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm ${
              firstSpecial ? 'mt-1 border-t border-edge pt-2' : ''
            } ${index === activeIndex ? 'bg-surface-overlay text-fg' : 'text-fg-secondary'}`}
          >
            {candidate.kind === 'user' ? (
              <>
                <Avatar name={candidate.user.displayName} seed={candidate.user.id} size={24} />
                <span className="min-w-0 truncate font-medium text-fg">{candidate.user.displayName}</span>
                <span className="truncate text-xs text-fg-muted">@{candidate.user.handle}</span>
                {!candidate.inChannel && <span className="ml-auto shrink-0 text-xs text-fg-muted">Not in channel</span>}
              </>
            ) : (
              <>
                <span className="font-semibold text-fg">@{candidate.name}</span>
                <span className="min-w-0 truncate text-xs text-fg-muted">{candidate.description}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
