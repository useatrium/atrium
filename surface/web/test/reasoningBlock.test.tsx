// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReasoningItem } from '@atrium/centaur-client';
import { ReasoningBlock } from '../src/sessions/ReasoningBlock';

afterEach(cleanup);

const item: ReasoningItem = {
  type: 'reasoning',
  id: 'reasoning-1',
  name: 'reasoning',
  input: {},
  text: 'Full internal reasoning\nwith a second line.',
  summary: 'Checking the transcript render branch',
  sourceEventIds: [1],
};

describe('ReasoningBlock (web)', () => {
  it('renders collapsed and expands to show reasoning text', () => {
    render(<ReasoningBlock item={item} />);

    const block = screen.getByTestId('reasoning-block');
    const button = within(block).getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(within(block).getByText('Thinking')).toBeTruthy();
    expect(within(block).getByText('Checking the transcript render branch')).toBeTruthy();
    expect(screen.queryByText(/Full internal reasoning/)).toBeNull();

    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/Full internal reasoning/)).toBeTruthy();
  });
});
