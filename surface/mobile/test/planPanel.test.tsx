// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodoEntry } from '@atrium/centaur-client';
import { PlanPanel } from '../src/components/PlanPanel';
import { ThemeProvider } from '../src/lib/theme';
import { renderWithTheme } from './rnTestUtils';

vi.mock('../src/components/Markdown', () => ({
  SessionMarkdown: ({ text }: { text: string }) => <Text>{text.replace(/^##\s+/m, '')}</Text>,
}));

afterEach(cleanup);

const todos: TodoEntry[] = [
  { content: 'Read mobile session UI', status: 'completed' },
  { content: 'Mount mobile panel', status: 'in_progress', activeForm: 'Mounting panel' },
  { content: 'Run mobile tests', status: 'pending' },
];

describe('PlanPanel (mobile)', () => {
  it('renders nothing without todos or a plan', () => {
    const { container } = renderWithTheme(<PlanPanel />);
    expect(container.childElementCount).toBe(0);
  });

  it('starts collapsed and expands to show current todos and markdown plan text', () => {
    renderWithTheme(<PlanPanel todos={todos} plan={{ text: '## Next\n\n- verify', sourceEventIds: [11] }} />);

    const panel = screen.getByTestId('plan-panel');
    expect(within(panel).getByText('Plan · 1/3 done')).toBeTruthy();
    expect(screen.queryByText('Read mobile session UI')).toBeNull();

    fireEvent.click(screen.getByLabelText('Plan · 1/3 done'));

    expect(screen.getByText('Read mobile session UI')).toBeTruthy();
    expect(screen.getByText('Mounting panel')).toBeTruthy();
    expect(screen.queryByText('Mount mobile panel')).toBeNull();
    expect(screen.getByText('Run mobile tests')).toBeTruthy();
    expect(screen.getByText(/Next/)).toBeTruthy();
  });

  it('updates in place when todos are replaced', () => {
    const { rerender } = renderWithTheme(<PlanPanel todos={[{ content: 'Old todo', status: 'pending' }]} />);
    fireEvent.click(screen.getByLabelText('Plan · 0/1 done'));
    expect(screen.getByText('Old todo')).toBeTruthy();

    rerender(
      <ThemeProvider>
        <PlanPanel todos={[{ content: 'New todo', status: 'completed' }]} />
      </ThemeProvider>,
    );

    expect(screen.getByText('Plan · 1/1 done')).toBeTruthy();
    expect(screen.queryByText('Old todo')).toBeNull();
    expect(screen.getByText('New todo')).toBeTruthy();
  });

  it('summarizes a free-text plan without todos', () => {
    renderWithTheme(<PlanPanel plan={{ text: 'Free-text only', sourceEventIds: [7] }} />);
    fireEvent.click(screen.getByLabelText('Plan'));
    expect(screen.getByText('Free-text only')).toBeTruthy();
  });
});
