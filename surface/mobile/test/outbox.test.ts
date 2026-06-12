import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDraftChangeDebouncer } from '../src/lib/outbox';

describe('draft persistence debounce', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces saves and clears immediately on send', async () => {
    vi.useFakeTimers();
    const writes: { key: string; text: string }[] = [];
    const drafts = createDraftChangeDebouncer((key, text) => {
      writes.push({ key, text });
    }, 400);

    drafts.schedule('channel:one', 'h');
    drafts.schedule('channel:one', 'he');
    await vi.advanceTimersByTimeAsync(399);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ key: 'channel:one', text: 'he' }]);

    drafts.schedule('channel:one', 'hello');
    drafts.saveNow('channel:one', '');
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toEqual([
      { key: 'channel:one', text: 'he' },
      { key: 'channel:one', text: '' },
    ]);
  });
});
