// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SideEffect } from '@atrium/centaur-client';
import { SideEffectsSurface } from '../src/sessions/SideEffectsSurface';

function effect(over: Partial<SideEffect>): SideEffect {
  return {
    id: 't1',
    command: 'curl https://example.com',
    category: 'network',
    risk: 'caution',
    toolName: 'Bash',
    sourceEventIds: [1],
    ...over,
  };
}

afterEach(cleanup);

describe('SideEffectsSurface', () => {
  it('groups effects by category and shows counts', () => {
    render(
      <SideEffectsSurface
        effects={[
          effect({ id: 't1', category: 'network', command: 'curl https://example.com' }),
          effect({ id: 't2', category: 'network', command: 'ssh deploy@example.com' }),
          effect({ id: 't3', category: 'package', command: 'npm install', risk: 'caution' }),
        ]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('· 3')).toBeTruthy();
    expect(screen.getByText('Network')).toBeTruthy();
    expect(screen.getByText('Package')).toBeTruthy();
    expect(screen.getByText('curl https://example.com')).toBeTruthy();
    expect(screen.getByText('npm install')).toBeTruthy();
  });

  it('renders risk badges', () => {
    render(
      <SideEffectsSurface
        effects={[
          effect({ id: 't1', command: 'rm -rf dist', category: 'filesystem', risk: 'danger' }),
          effect({ id: 't2', command: 'ls', category: 'shell', risk: 'normal' }),
        ]}
        onClose={() => {}}
      />,
    );

    const surface = screen.getByTestId('sideeffects-surface');
    expect(within(surface).getByText('danger')).toBeTruthy();
    expect(within(surface).getByText('normal')).toBeTruthy();
  });

  it('closes via the header button', () => {
    const onClose = vi.fn();
    render(<SideEffectsSurface effects={[effect({})]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close what it ran' }));
    expect(onClose).toHaveBeenCalled();
  });
});
