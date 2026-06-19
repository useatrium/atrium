// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { FileChange, SideEffect } from '@atrium/centaur-client';
import { renderWithTheme as renderUI } from './rnTestUtils';
import { ChangesSurface } from '../src/components/work/ChangesSurface';
import { SideEffectsSurface } from '../src/components/work/SideEffectsSurface';

afterEach(cleanup);

function fileChange(over: Partial<FileChange>): FileChange {
  return {
    id: 'c1',
    path: 'src/App.tsx',
    kind: 'update',
    diff: ' const kept = true;\n+const added = 1;\n+const next = 2;\n-const removed = 0;',
    toolName: 'Edit',
    sourceEventIds: [1],
    ...over,
  };
}

function sideEffect(over: Partial<SideEffect>): SideEffect {
  return {
    id: 'e1',
    command: 'pnpm add left-pad',
    category: 'package',
    risk: 'caution',
    toolName: 'Bash',
    sourceEventIds: [2],
    ...over,
  };
}

describe('ChangesSurface (mobile)', () => {
  it('renders a file row with counts and expands its diff on press', () => {
    renderUI(<ChangesSurface changes={[fileChange({})]} />);

    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
    expect(screen.queryByText('+const added = 1;')).toBeNull();

    fireEvent.click(screen.getByText('src/App.tsx'));

    expect(screen.getByText('+const added = 1;')).toBeInTheDocument();
    expect(screen.getByText('-const removed = 0;')).toBeInTheDocument();
  });

  it('shows an empty state when there are no file changes', () => {
    renderUI(<ChangesSurface changes={[]} />);
    expect(screen.getByText('No file changes.')).toBeInTheDocument();
  });
});

describe('SideEffectsSurface (mobile)', () => {
  it('renders a command with its category label and risk badge', () => {
    renderUI(<SideEffectsSurface effects={[sideEffect({})]} />);

    expect(screen.getByText('pnpm add left-pad')).toBeInTheDocument();
    expect(screen.getByText('Package')).toBeInTheDocument();
    expect(screen.getByText('caution')).toBeInTheDocument();
  });

  it('shows an empty state when there are no side-effects', () => {
    renderUI(<SideEffectsSurface effects={[]} />);
    expect(screen.getByText('No side-effects.')).toBeInTheDocument();
  });
});
