// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TodoEntry } from '@atrium/centaur-client';
import { PlanPanel } from '../src/sessions/PlanPanel';

afterEach(cleanup);

const todos: TodoEntry[] = [
  { content: 'Read the current session UI', status: 'completed' },
  { content: 'Wire the panel into the transcript', status: 'in_progress', activeForm: 'Wiring panel' },
  { content: 'Run focused tests', status: 'pending' },
];

describe('PlanPanel (web)', () => {
  it('renders nothing without todos or a plan', () => {
    const { container } = render(<PlanPanel />);
    expect(container.childElementCount).toBe(0);
  });

  it('starts collapsed and expands to show current todos and markdown plan text', () => {
    render(<PlanPanel todos={todos} plan={{ text: '## Next\n\n- verify', sourceEventIds: [11] }} />);

    const panel = screen.getByTestId('plan-panel');
    const button = within(panel).getByRole('button', { name: 'Plan · 1/3 done' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Read the current session UI')).toBeNull();

    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Read the current session UI')).toBeTruthy();
    expect(screen.getByText('Wiring panel')).toBeTruthy();
    expect(screen.queryByText('Wire the panel into the transcript')).toBeNull();
    expect(screen.getByText('Run focused tests')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Next' })).toBeTruthy();
  });

  it('updates in place when todos are replaced', () => {
    const { rerender } = render(<PlanPanel todos={[{ content: 'Old todo', status: 'pending' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Plan · 0/1 done' }));
    expect(screen.getByText('Old todo')).toBeTruthy();

    rerender(<PlanPanel todos={[{ content: 'New todo', status: 'completed' }]} />);

    expect(screen.getByRole('button', { name: 'Plan · 1/1 done' })).toBeTruthy();
    expect(screen.queryByText('Old todo')).toBeNull();
    expect(screen.getByText('New todo')).toBeTruthy();
  });

  it('summarizes a free-text plan without todos', () => {
    render(<PlanPanel plan={{ text: 'Free-text only', sourceEventIds: [7] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(screen.getByText('Free-text only')).toBeTruthy();
  });
});
