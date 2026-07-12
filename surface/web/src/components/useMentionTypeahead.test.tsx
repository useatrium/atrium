// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MentionSuggestions } from './MentionSuggestions';
import { clearMentionTypeaheadCachesForTests, useMentionTypeahead } from './useMentionTypeahead';
import { ThemeProvider } from '../theme';

const ada = { id: '11111111-1111-4111-8111-111111111111', handle: 'ada', displayName: 'Ada Lovelace' };
const ben = { id: '22222222-2222-4222-8222-222222222222', handle: 'ben', displayName: 'Ben Bitdiddle' };
const channelMembers = vi.hoisted(() => vi.fn());
const users = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({ api: { channelMembers, users } }));

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const [sent, setSent] = useState(0);
  const [serialized, setSerialized] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionTypeahead({
    value,
    setValue,
    textareaRef: ref,
    context: { channelId: 'channel-1', includeSpecials: true, publicChannel: false },
  });
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.onKeyDown(event)) return;
    if (event.key === 'Enter') setSent((count) => count + 1);
  };
  return (
    <div>
      {mention.open && (
        <MentionSuggestions
          activeIndex={mention.activeIndex}
          candidates={mention.candidates}
          listboxId={mention.listboxId}
          optionId={mention.optionId}
          onActiveIndexChange={mention.setActiveIndex}
          onInsert={mention.insert}
        />
      )}
      <textarea
        aria-label="Harness input"
        ref={ref}
        value={value}
        onChange={(event) =>
          mention.onValueChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
        }
        onSelect={(event) => mention.trackSelection(event.currentTarget)}
        onKeyUp={(event) => mention.trackSelection(event.currentTarget)}
        onKeyDown={onKeyDown}
      />
      <button type="button" onClick={() => setSerialized(mention.serialize(value))}>
        Serialize
      </button>
      <output aria-label="serialized">{serialized}</output>
      <output aria-label="sent">{sent}</output>
    </div>
  );
}

beforeEach(() => {
  clearMentionTypeaheadCachesForTests();
  channelMembers.mockReset().mockResolvedValue({ members: [ada, ben] });
  users.mockReset().mockResolvedValue({ users: [ada, ben] });
});

afterEach(cleanup);

describe('useMentionTypeahead', () => {
  it('detects the trigger at the caret rather than only at the end', async () => {
    render(
      <ThemeProvider>
        <Harness initial="hello @ad trailing" />
      </ThemeProvider>,
    );
    expect(channelMembers).not.toHaveBeenCalled();
    expect(users).not.toHaveBeenCalled();
    const input = screen.getByRole('textbox', { name: 'Harness input' }) as HTMLTextAreaElement;
    input.setSelectionRange(9, 9);
    fireEvent.select(input);

    expect(await screen.findByRole('option', { name: /Ada Lovelace/ })).toBeTruthy();
    expect(channelMembers).toHaveBeenCalledWith('channel-1');
    expect(users).toHaveBeenCalledTimes(1);
  });

  it('cycles with arrows and Enter inserts instead of sending; Escape dismisses until the prefix changes', async () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Harness input' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } });
    await screen.findByRole('listbox', { name: 'Mention suggestions' });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('@ben ');
    expect(screen.getByLabelText('sent').textContent).toBe('0');

    fireEvent.change(input, { target: { value: '@' } });
    await screen.findByRole('listbox', { name: 'Mention suggestions' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '@a' } });
    expect(await screen.findByRole('listbox')).toBeTruthy();
  });

  it('records, shifts, drops, and serializes user mention ranges', async () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Harness input' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@ad' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Ada Lovelace/ }));
    expect(input.value).toBe('@ada ');

    fireEvent.change(input, { target: { value: 'hi @ada ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Serialize' }));
    expect(screen.getByLabelText('serialized').textContent).toBe(`hi <@${ada.id}> `);

    fireEvent.change(input, { target: { value: 'hi @axda ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Serialize' }));
    await waitFor(() => expect(screen.getByLabelText('serialized').textContent).toBe('hi @axda '));
  });
});
