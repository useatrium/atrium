// @vitest-environment jsdom

import type { SubagentGroup } from '@atrium/centaur-client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsStrip } from './AgentsStrip';

afterEach(cleanup);

const group = (over: Partial<SubagentGroup>): SubagentGroup => ({
  parentId: 'toolu_task1',
  subagentType: 'Explore',
  description: 'map the seam',
  status: 'running',
  items: [],
  stepCount: 0,
  ...over,
});

describe('AgentsStrip', () => {
  it('renders nothing without subagents', () => {
    const { container } = render(<AgentsStrip groups={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a roster with a live running count', () => {
    render(
      <AgentsStrip
        groups={[group({ parentId: 'a', status: 'running' }), group({ parentId: 'b', status: 'completed' })]}
      />,
    );
    expect(screen.getByText('2 agents')).toBeTruthy();
    expect(screen.getByTestId('agents-strip-running').textContent).toContain('1 running');
    expect(screen.getAllByText(/map the seam/)).toHaveLength(2);
  });

  it('expands a subagent to drill into its steps and is keyboard operable', () => {
    render(
      <AgentsStrip
        groups={[
          group({
            parentId: 'a',
            status: 'completed',
            stepCount: 1,
            items: [
              {
                type: 'tool_call',
                id: 'sub~a~toolu_r',
                name: 'Read',
                input: { file_path: 'README.md' },
                executionId: null,
                sourceEventIds: [],
                result: { content: 'ok', is_error: false },
              },
            ],
          }),
        ]}
      />,
    );

    const toggle = screen.getByRole('button', { name: /Explore/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The drill-in fold is not mounted until expanded.
    expect(screen.queryByTestId('work-fold-expanded')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('work-fold-expanded')).toBeTruthy();
  });

  it('disables drill-in for a subagent with no steps', () => {
    render(<AgentsStrip groups={[group({ parentId: 'a', stepCount: 0, items: [] })]} />);
    const toggle = screen.getByRole('button', { name: /Explore/ });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});
