// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { isModalDialogOpen } from '../useDialog';
import { EscapeLayer, escapeHasLocalMeaning, isPlainEscape, useEscapeLayer } from './escapeLayers';

vi.mock('../useDialog', () => ({ isModalDialogOpen: vi.fn(() => false) }));

const modalOpen = isModalDialogOpen as Mock;

afterEach(() => {
  cleanup();
  modalOpen.mockReturnValue(false);
  vi.clearAllMocks();
});

function pressEscape(target: EventTarget = window, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('escapeLayers dispatcher', () => {
  it('routes a press to the highest-priority layer only', () => {
    const high = vi.fn(() => true);
    const low = vi.fn(() => true);
    renderHook(() => {
      useEscapeLayer(EscapeLayer.turn, high);
      useEscapeLayer(EscapeLayer.dock, low);
    });

    const event = pressEscape();

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('falls through to the next layer when the topmost declines', () => {
    const high = vi.fn(() => false);
    const low = vi.fn(() => true);
    renderHook(() => {
      useEscapeLayer(EscapeLayer.turn, high);
      useEscapeLayer(EscapeLayer.dock, low);
    });

    pressEscape();

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no layer claims the press', () => {
    const decline = vi.fn(() => false);
    renderHook(() => useEscapeLayer(EscapeLayer.dock, decline));

    const event = pressEscape();

    expect(decline).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('breaks priority ties in favor of the most recently registered layer', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    renderHook(() => {
      useEscapeLayer(EscapeLayer.dock, first);
      useEscapeLayer(EscapeLayer.dock, second);
    });

    pressEscape();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('deregisters a layer on unmount', () => {
    const handler = vi.fn(() => true);
    const { unmount } = renderHook(() => useEscapeLayer(EscapeLayer.dock, handler));

    pressEscape();
    expect(handler).toHaveBeenCalledTimes(1);

    unmount();
    pressEscape();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not register while disabled', () => {
    const handler = vi.fn(() => true);
    renderHook(() => useEscapeLayer(EscapeLayer.dock, handler, false));

    pressEscape();

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores modified and repeated Escape presses', () => {
    const handler = vi.fn(() => true);
    renderHook(() => useEscapeLayer(EscapeLayer.dock, handler));

    pressEscape(window, { metaKey: true });
    pressEscape(window, { repeat: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores an already-defaultPrevented press', () => {
    const handler = vi.fn(() => true);
    renderHook(() => useEscapeLayer(EscapeLayer.dock, handler));

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
  });

  it('stands down entirely while a modal dialog owns Escape', () => {
    modalOpen.mockReturnValue(true);
    const handler = vi.fn(() => true);
    renderHook(() => useEscapeLayer(EscapeLayer.turn, handler));

    const event = pressEscape();

    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('lets a layer defer to an editable target so a lower layer wins', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const turn = vi.fn((event: KeyboardEvent) => (escapeHasLocalMeaning(event) ? false : true));
    const dock = vi.fn(() => true);
    renderHook(() => {
      useEscapeLayer(EscapeLayer.turn, turn);
      useEscapeLayer(EscapeLayer.dock, dock);
    });

    pressEscape(input);

    expect(turn).toHaveBeenCalledTimes(1);
    expect(dock).toHaveBeenCalledTimes(1);
    input.remove();
  });
});

describe('escapeHasLocalMeaning', () => {
  it('flags editable targets', () => {
    const input = document.createElement('input');
    expect(escapeHasLocalMeaning({ target: input } as unknown as KeyboardEvent)).toBe(true);
  });

  it('flags targets inside a menu', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.appendChild(item);
    expect(escapeHasLocalMeaning({ target: item } as unknown as KeyboardEvent)).toBe(true);
  });

  it('does not flag a plain, non-editable target', () => {
    const div = document.createElement('div');
    expect(escapeHasLocalMeaning({ target: div } as unknown as KeyboardEvent)).toBe(false);
  });
});

describe('isPlainEscape', () => {
  it('accepts a bare Escape', () => {
    expect(isPlainEscape(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
  });

  it('rejects modified, repeated, or non-Escape keys', () => {
    expect(isPlainEscape(new KeyboardEvent('keydown', { key: 'Escape', metaKey: true }))).toBe(false);
    expect(isPlainEscape(new KeyboardEvent('keydown', { key: 'Escape', repeat: true }))).toBe(false);
    expect(isPlainEscape(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
  });
});
