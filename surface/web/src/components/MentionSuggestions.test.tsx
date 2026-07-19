// @vitest-environment jsdom

import type { MentionCandidate } from '@atrium/surface-client';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionSuggestions } from './MentionSuggestions';

afterEach(cleanup);

// Special candidates avoid the Avatar (which needs ThemeProvider) so the test
// stays focused on the selection/scroll behavior.
const candidates: MentionCandidate[] = [
  { kind: 'special', name: 'channel', description: 'Notify the channel' },
  { kind: 'special', name: 'here', description: 'Notify who is here' },
];

function renderSuggestions(activeIndex: number) {
  return render(
    <MentionSuggestions
      activeIndex={activeIndex}
      candidates={candidates}
      listboxId="mentions"
      optionId={(index) => `mention-option-${index}`}
      onActiveIndexChange={vi.fn()}
      onInsert={vi.fn()}
    />,
  );
}

describe('MentionSuggestions', () => {
  it('scrolls the active option into view when the selection changes', () => {
    // jsdom elements have no scrollIntoView — stub it so the effect can run.
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    const { rerender } = renderSuggestions(0);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerender(
      <MentionSuggestions
        activeIndex={1}
        candidates={candidates}
        listboxId="mentions"
        optionId={(index) => `mention-option-${index}`}
        onActiveIndexChange={vi.fn()}
        onInsert={vi.fn()}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    // The most recent call is bound to the newly active (second) option.
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById('mention-option-1'));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
  });

  it('gives the active option an unmistakable highlight', () => {
    const { container } = renderSuggestions(1);
    const options = container.querySelectorAll('[role="option"]');
    expect(options[1]?.className).toContain('bg-accent/20');
    expect(options[0]?.className).not.toContain('bg-accent/20');
  });
});
