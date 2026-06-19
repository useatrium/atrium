// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { SessionItem } from '@atrium/centaur-client';
import { renderWithTheme as renderUI } from './rnTestUtils';
import { TurnCard } from '../src/components/work/TurnCard';
import { TurnsSheet } from '../src/components/work/TurnsSheet';
import { deriveTurns, type Turn } from '../src/components/work/turns';

afterEach(cleanup);

function textItem(id: string, text = 'Agent output'): SessionItem {
  return { type: 'text', id, text, sourceEventIds: [1] };
}

function steerItem(id: string, text: string): SessionItem {
  return { type: 'user_message', id, text, sourceEventIds: [2] };
}

describe('deriveTurns', () => {
  it('returns no turns for an empty transcript', () => {
    expect(deriveTurns([])).toEqual([]);
  });

  it('creates one Turn 1 anchor for transcripts without steers', () => {
    expect(deriveTurns([textItem('agent-1'), textItem('agent-2')])).toEqual([
      { id: 'agent-1', index: 1, label: 'Turn 1', itemId: 'agent-1' },
    ]);
  });

  it('segments by user_message boundaries and anchors each turn to the segment start', () => {
    const turns = deriveTurns([
      textItem('agent-intro'),
      textItem('agent-more'),
      steerItem('steer-1', 'Fix login flow'),
      textItem('agent-reply'),
      steerItem('steer-2', 'Ship it'),
    ]);

    expect(turns).toEqual([
      { id: 'agent-intro', index: 1, label: 'Turn 1', itemId: 'agent-intro' },
      { id: 'steer-1', index: 2, label: 'Turn 2 - Fix login flow', itemId: 'steer-1' },
      { id: 'steer-2', index: 3, label: 'Turn 3 - Ship it', itemId: 'steer-2' },
    ]);
  });

  it('uses the first steer as Turn 1 when the transcript starts with a user_message', () => {
    expect(deriveTurns([steerItem('steer-1', 'Start here'), textItem('agent-1')])).toEqual([
      { id: 'steer-1', index: 1, label: 'Turn 1 - Start here', itemId: 'steer-1' },
    ]);
  });

  it('shortens long steer excerpts in labels', () => {
    const [turn] = deriveTurns([
      steerItem('steer-1', 'Please summarize the deployment plan and include blockers'),
    ]);

    expect(turn?.label).toBe('Turn 1 - Please summarize the deployment plan...');
  });
});

describe('TurnsSheet', () => {
  const turns: Turn[] = [
    { id: 'agent-intro', index: 1, label: 'Turn 1', itemId: 'agent-intro' },
    { id: 'steer-1', index: 2, label: 'Turn 2 - Fix login flow', itemId: 'steer-1' },
  ];

  it('renders turn rows and jumps to the selected item before closing', () => {
    const onJump = vi.fn();
    const onClose = vi.fn();

    renderUI(<TurnsSheet visible turns={turns} onJump={onJump} onClose={onClose} />);

    expect(screen.getByText('Turns')).toBeInTheDocument();
    expect(screen.getByText('Turn 1')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Turn 2 - Fix login flow'));

    expect(onJump).toHaveBeenCalledWith('steer-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('TurnCard', () => {
  it('shows result text and formatted cost', () => {
    renderUI(<TurnCard status="idle" resultText="All checks passed." costUsd={0.1234} />);

    expect(screen.getByTestId('turn-card')).toHaveAccessibleName('Turn idle summary');
    expect(screen.getByText('RESULT')).toBeInTheDocument();
    expect(screen.getByText('All checks passed.')).toBeInTheDocument();
    expect(screen.getByText('$0.1234')).toBeInTheDocument();
  });
});
