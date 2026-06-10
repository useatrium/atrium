import { useRef, useState, type KeyboardEvent } from 'react';

export function Composer({
  placeholder,
  onSend,
  autoFocus,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-end gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 focus-within:border-zinc-500">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={onKeyDown}
          className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-100 placeholder-zinc-500 outline-none"
        />
        <button
          onClick={send}
          disabled={!text.trim()}
          className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-default disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          Send
        </button>
      </div>
      <div className="mt-1 px-1 text-[10px] text-zinc-600">
        Enter to send · Shift+Enter for a new line
      </div>
    </div>
  );
}
