// @vitest-environment jsdom
// ConflictSurface: both-sides render + one-action resolution.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictSurface,
  ConflictBanner,
  VersionSkewBadge,
  type ArtifactConflict,
} from '../src/sessions/ConflictSurface';

function conflict(over: Partial<ArtifactConflict> = {}): ArtifactConflict {
  return {
    artifactId: 'art-1',
    path: 'proj-x/plan.md',
    kind: 'diff3',
    conflictSeq: 6,
    baseSeq: 4,
    base: { sha: 'b', text: 'line1\nline2\nline3\n' },
    left: { label: 'theirs (v5, alice)', author: 'human:alice', sha: 'l', text: 'line1\nLEFT\nline3\n' },
    right: { label: 'yours (agent)', author: 'agent:s1', sha: 'r', text: 'line1\nRIGHT\nline3\n' },
    markers: '<<<<<<< theirs\nLEFT\n=======\nRIGHT\n>>>>>>> yours\n',
    ...over,
  };
}

afterEach(cleanup);

describe('ConflictSurface', () => {
  it('renders the path, conflict seq, and both side labels', () => {
    render(<ConflictSurface conflict={conflict()} onResolve={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('proj-x/plan.md')).toBeTruthy();
    expect(screen.getByText('· v6')).toBeTruthy();
    expect(screen.getByText('theirs (v5, alice)')).toBeTruthy();
    expect(screen.getByText('yours (agent)')).toBeTruthy();
  });

  it('Keep theirs / Keep yours call onResolve with the side', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ConflictSurface conflict={conflict()} onResolve={onResolve} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Keep theirs'));
    expect(onResolve).toHaveBeenLastCalledWith({ kind: 'left' });
    // let the in-flight resolve settle (re-enables the buttons) before the next.
    await waitFor(() => expect((screen.getByText('Keep yours') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('Keep yours'));
    expect(onResolve).toHaveBeenLastCalledWith({ kind: 'right' });
  });

  it('editing the merge box + Apply merged sends the edited text', () => {
    const onResolve = vi.fn();
    render(<ConflictSurface conflict={conflict()} onResolve={onResolve} onClose={vi.fn()} />);
    const box = screen.getByLabelText('merged resolution') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'line1\nRESOLVED\nline3\n' } });
    fireEvent.click(screen.getByText('Apply merged'));
    expect(onResolve).toHaveBeenCalledWith({ kind: 'merged', text: 'line1\nRESOLVED\nline3\n' });
  });

  it('disables actions while a resolve is in flight', async () => {
    let release: () => void = () => {};
    const onResolve = vi.fn().mockReturnValue(new Promise<void>((r) => (release = r)));
    render(<ConflictSurface conflict={conflict()} onResolve={onResolve} onClose={vi.fn()} />);
    const keepTheirs = screen.getByText('Keep theirs') as HTMLButtonElement;
    fireEvent.click(keepTheirs);
    await waitFor(() => expect(keepTheirs.disabled).toBe(true));
    // a second click while pending is a no-op
    fireEvent.click(screen.getByText('Keep yours'));
    expect(onResolve).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(keepTheirs.disabled).toBe(false));
  });

  it('pre-fills the merge box with the conflict markers', () => {
    render(<ConflictSurface conflict={conflict()} onResolve={vi.fn()} onClose={vi.fn()} />);
    const box = screen.getByLabelText('merged resolution') as HTMLTextAreaElement;
    expect(box.value).toContain('<<<<<<<');
    expect(box.value).toContain('RIGHT');
  });
});

describe('ConflictBanner', () => {
  it('shows the count and fires onOpen; renders nothing at zero', () => {
    const onOpen = vi.fn();
    const { rerender, container } = render(<ConflictBanner count={2} onOpen={onOpen} />);
    expect(screen.getByText('2 unresolved conflicts')).toBeTruthy();
    fireEvent.click(screen.getByText('2 unresolved conflicts'));
    expect(onOpen).toHaveBeenCalled();
    rerender(<ConflictBanner count={0} onOpen={onOpen} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('uses the singular for one conflict', () => {
    render(<ConflictBanner count={1} onOpen={vi.fn()} />);
    expect(screen.getByText('1 unresolved conflict')).toBeTruthy();
  });
});

describe('VersionSkewBadge', () => {
  it('renders nothing when in sync and a pill when behind', () => {
    const { container, rerender } = render(<VersionSkewBadge workingSeq={5} latestSeq={5} />);
    expect(container.firstChild).toBeNull();
    rerender(<VersionSkewBadge workingSeq={5} latestSeq={7} />);
    expect(screen.getByText('newer: v7')).toBeTruthy();
  });
});
