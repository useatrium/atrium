import { REACTION_GROUPS, searchReactions } from '@atrium/surface-client/reactions';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useDialog } from '../useDialog';

const GRID_COLUMNS = 8;

export function ReactionPicker({
  open,
  onClose,
  onSelect,
  labelId,
  className = '',
  invokerRef,
  restoreFocus = true,
  closeOnOutsidePointer = true,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  labelId?: string;
  className?: string;
  invokerRef?: RefObject<HTMLElement | null>;
  restoreFocus?: boolean;
  closeOnOutsidePointer?: boolean;
}) {
  const generatedLabelId = useId();
  const resolvedLabelId = labelId ?? `${generatedLabelId}-label`;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const emojiRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const trimmedQuery = query.trim();
  const flatResults = useMemo(() => searchReactions(query), [query]);
  const visibleEmojis = useMemo(
    () => (trimmedQuery ? flatResults : REACTION_GROUPS.flatMap((group) => group.emojis)),
    [flatResults, trimmedQuery],
  );

  const closePicker = useCallback(() => {
    onClose();
  }, [onClose]);

  useDialog({
    open,
    containerRef,
    initialFocusRef: inputRef,
    invokerRef,
    restoreFocus,
    closeOnOutsidePointer,
    onClose: closePicker,
  });

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (activeIndex <= visibleEmojis.length - 1) return;
    setActiveIndex(Math.max(0, visibleEmojis.length - 1));
  }, [activeIndex, visibleEmojis.length]);

  if (!open) return null;

  const focusEmoji = (index: number) => {
    if (visibleEmojis.length === 0) return;
    const next = Math.max(0, Math.min(visibleEmojis.length - 1, index));
    setActiveIndex(next);
    window.setTimeout(() => emojiRefs.current[next]?.focus());
  };

  const selectEmoji = (emoji: string) => {
    onSelect(emoji);
    onClose();
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (visibleEmojis.length === 0) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusEmoji(activeIndex + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusEmoji(activeIndex - 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusEmoji(activeIndex + GRID_COLUMNS);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusEmoji(activeIndex - GRID_COLUMNS);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusEmoji(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusEmoji(visibleEmojis.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const emoji = visibleEmojis[activeIndex];
      if (emoji) selectEmoji(emoji);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (visibleEmojis.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusEmoji(activeIndex);
    } else if (event.key === 'Enter') {
      // Enter from the search box selects the active (first, when unfiltered)
      // emoji — preserves the "open picker → Enter reacts with 👍" keyboard flow.
      event.preventDefault();
      const emoji = visibleEmojis[activeIndex] ?? visibleEmojis[0];
      if (emoji) selectEmoji(emoji);
    }
  };

  let emojiIndex = 0;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-labelledby={resolvedLabelId}
      className={`rounded-md border border-edge-strong bg-surface-overlay p-2 shadow-lg ${className}`}
    >
      <div id={resolvedLabelId} className="sr-only">
        Add reaction
      </div>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={onSearchKeyDown}
        placeholder="Search reactions"
        aria-label="Search reactions"
        className="mb-2 h-8 w-full rounded-md border border-edge bg-surface-raised px-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent-hover"
      />
      {/* biome-ignore lint/a11y/useSemanticElements: emoji picker keeps the existing ARIA grid pattern over buttons. */}
      <div
        role="grid"
        aria-label="Reaction choices"
        onKeyDown={onGridKeyDown}
        className="grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto"
      >
        {trimmedQuery ? (
          flatResults.length > 0 ? (
            flatResults.map((emoji, index) => (
              <ReactionButton
                key={emoji}
                emoji={emoji}
                active={index === activeIndex}
                buttonRef={(el) => {
                  emojiRefs.current[index] = el;
                }}
                onFocus={() => setActiveIndex(index)}
                onSelect={selectEmoji}
              />
            ))
          ) : (
            <div role="status" className="col-span-8 px-1 py-3 text-center text-xs text-fg-muted">
              No reactions found
            </div>
          )
        ) : (
          REACTION_GROUPS.map((group) => (
            <div key={group.name} className="contents">
              <div className="col-span-8 px-1 pb-0.5 pt-1 text-3xs font-medium uppercase text-fg-muted">
                {group.name}
              </div>
              {group.emojis.map((emoji) => {
                const index = emojiIndex;
                emojiIndex += 1;
                return (
                  <ReactionButton
                    key={emoji}
                    emoji={emoji}
                    active={index === activeIndex}
                    buttonRef={(el) => {
                      emojiRefs.current[index] = el;
                    }}
                    onFocus={() => setActiveIndex(index)}
                    onSelect={selectEmoji}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ReactionButton({
  emoji,
  active,
  buttonRef,
  onFocus,
  onSelect,
}: {
  emoji: string;
  active: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onSelect: (emoji: string) => void;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      tabIndex={active ? 0 : -1}
      onFocus={onFocus}
      onClick={() => onSelect(emoji)}
      aria-label={`React with ${emoji}`}
      className="h-8 rounded text-base leading-none hover:bg-edge-strong focus:bg-edge-strong focus:outline-none"
    >
      {emoji}
    </button>
  );
}
