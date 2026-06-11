import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { looksLikeAgentCommand, parseAgentTask } from '../sessions/spawn';

export function Composer({
  placeholder,
  onSend,
  onTyping,
  onArrowUpOnEmpty,
  autoFocus,
  agentAware,
  disabled,
  disabledHint,
  footer,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  /** Fired while the user types non-empty text (throttle at the call site). */
  onTyping?: () => void;
  /** ArrowUp in an empty composer — Slack-style "edit my last message". */
  onArrowUpOnEmpty?: () => void;
  autoFocus?: boolean;
  /** Show the "@agent spawns a session" hint chip while the grammar matches. */
  agentAware?: boolean;
  disabled?: boolean;
  disabledHint?: string;
  /** Replaces the default hint line (e.g. seat request controls in the pane). */
  footer?: ReactNode;
}) {
  const [text, setText] = useState('');
  // "@agent" with no task: refuse to post the literal string — show what's
  // missing instead (cleared as soon as the text changes).
  const [agentNeedsTask, setAgentNeedsTask] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const agentHint = !!agentAware && !disabled && looksLikeAgentCommand(text);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    if (agentAware && looksLikeAgentCommand(trimmed) && parseAgentTask(trimmed) == null) {
      setAgentNeedsTask(true);
      return;
    }
    onSend(trimmed);
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && text === '' && onArrowUpOnEmpty) {
      e.preventDefault();
      onArrowUpOnEmpty();
    }
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-3">
      <div
        title={disabled ? disabledHint : undefined}
        className={`flex items-end gap-2 rounded-lg border px-3 py-2 ${
          disabled
            ? 'border-zinc-800 bg-zinc-900/40'
            : 'border-zinc-700 bg-zinc-900 focus-within:border-zinc-500'
        }`}
      >
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={disabled ? (disabledHint ?? placeholder) : placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setAgentNeedsTask(false);
            if (e.target.value.trim()) onTyping?.();
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={onKeyDown}
          className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-100 placeholder-zinc-500 outline-none disabled:cursor-not-allowed disabled:placeholder-zinc-600"
        />
        <button
          onClick={send}
          disabled={!text.trim() || disabled}
          title={disabled ? disabledHint : undefined}
          className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-default disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          Send
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 px-1 text-[10px] text-zinc-500">
        {agentNeedsTask ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-300">
            Add a task: @agent &lt;task&gt;
          </span>
        ) : agentHint ? (
          <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 font-medium text-indigo-300">
            @agent — spawns an agent session
          </span>
        ) : footer !== undefined ? (
          footer
        ) : (
          <span>
            {disabled
              ? (disabledHint ?? '')
              : agentAware
                ? 'Enter to send · Shift+Enter for a new line · @agent <task> spawns an agent'
                : 'Enter to send · Shift+Enter for a new line'}
          </span>
        )}
      </div>
    </div>
  );
}
