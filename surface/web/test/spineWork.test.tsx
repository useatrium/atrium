// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FoldedTurnRow, ToolCallItem, TurnWorkItem } from '@atrium/centaur-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../src/theme';
import { WorkFold } from '../src/sessions/WorkFold';

afterEach(cleanup);

function tool(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    type: 'tool_call',
    id: 'tool-1',
    name: 'Bash',
    input: { command: 'pnpm test' },
    result: { content: Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'), is_error: false },
    sourceEventIds: [1],
    ...overrides,
    executionId: overrides.executionId ?? null,
  };
}

function fold(item = tool()): FoldedTurnRow {
  return {
    kind: 'fold',
    key: 'turn-0',
    turn: 0,
    executionId: item.executionId,
    items: [item],
    toolNames: [item.name],
    startIndex: 1,
    endIndex: 1,
    triggerIndex: 0,
    triggerOrdinal: 0,
    replyIndex: 2,
    durationMs: 3200,
    completed: true,
  };
}

function renderFold(
  props: {
    live?: boolean;
    expandAll?: boolean;
    onOpenWork?: () => void;
    onDiscussStep?: (item: TurnWorkItem) => void;
    item?: ToolCallItem;
  } = {},
) {
  const renderedFold = props.item ? fold(props.item) : props.live ? fold(tool({ result: undefined })) : fold();
  return render(
    <ThemeProvider>
      <WorkFold
        fold={renderedFold}
        live={props.live ?? false}
        expandAll={props.expandAll}
        onOpenWork={props.onOpenWork}
        onDiscussStep={props.onDiscussStep}
      />
    </ThemeProvider>,
  );
}

describe('spine work fold disclosure', () => {
  it('starts completed turns collapsed', () => {
    renderFold();
    expect(screen.getByTestId('work-fold-collapsed').textContent).toContain('1 step · Bash · 3s');
    expect(screen.queryByTestId('work-fold-expanded')).toBeNull();
  });

  it('streams a live turn open and auto-collapses when it completes', () => {
    const view = renderFold({ live: true });
    expect(screen.getByTestId('work-fold-expanded')).toBeTruthy();
    expect(screen.getByText('●').className).toContain('animate-pulse');

    view.rerender(
      <ThemeProvider>
        <WorkFold fold={fold()} live={false} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('work-fold-collapsed')).toBeTruthy();
  });

  it('follows the pane-level expand-all preference while retaining per-fold disclosure', () => {
    const view = renderFold({ expandAll: true });
    expect(screen.getByTestId('work-fold-expanded')).toBeTruthy();

    view.rerender(
      <ThemeProvider>
        <WorkFold fold={fold()} live={false} expandAll={false} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('work-fold-collapsed')).toBeTruthy();
  });

  it('expands fold, step, and clipped detail, then opens What it ran', () => {
    const onOpenWork = vi.fn();
    renderFold({ onOpenWork });

    fireEvent.click(screen.getByTestId('work-fold-collapsed'));
    fireEvent.click(screen.getByRole('button', { name: /pnpm test/i }));

    const detail = screen.getByTestId('step-detail-tool-1');
    expect(detail.querySelector('pre')?.className).toContain('overflow-hidden');
    expect(detail.textContent).toContain('line 19');
    fireEvent.click(screen.getByRole('button', { name: 'full output → What it ran' }));
    expect(onOpenWork).toHaveBeenCalledTimes(1);
  });

  it('keeps the pane discuss affordance on addressable work steps', () => {
    const onDiscussStep = vi.fn();
    const item = tool({ handle: 'rec_tool' });
    renderFold({ item, onDiscussStep });

    fireEvent.click(screen.getByTestId('work-fold-collapsed'));
    fireEvent.click(screen.getByRole('button', { name: /pnpm test/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Discuss in thread' }));
    expect(onDiscussStep).toHaveBeenCalledWith(item);
  });
});
