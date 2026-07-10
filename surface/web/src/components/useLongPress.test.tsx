// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLongPress } from './useLongPress';

function LongPressTarget({
  disabled,
  onLongPress,
}: {
  disabled?: boolean;
  onLongPress: () => void;
}) {
  const { pressing: _pressing, ...longPressHandlers } = useLongPress({
    disabled,
    delayMs: 400,
    onLongPress,
  });
  return (
    <div data-testid="long-press-target" {...longPressHandlers}>
      <span>Message text</span>
      <button type="button">Nested action</button>
    </div>
  );
}

function dispatchPointer(
  target: Element,
  type: string,
  init: {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
    pointerType?: string;
  } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 20,
    clientY: init.clientY ?? 20,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? 'touch' },
  });
  fireEvent(target, event);
  return event;
}

function webkitUserSelect(element: HTMLElement) {
  return (element.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect;
}

let touchEventDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  touchEventDescriptor = Object.getOwnPropertyDescriptor(window, 'TouchEvent');
  Object.defineProperty(window, 'TouchEvent', { configurable: true, value: Event });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (touchEventDescriptor) {
    Object.defineProperty(window, 'TouchEvent', touchEventDescriptor);
  } else {
    Reflect.deleteProperty(window, 'TouchEvent');
  }
});

describe('useLongPress', () => {
  it('fires after the hold delay and restores inline suppression on release', () => {
    const onLongPress = vi.fn();
    render(<LongPressTarget onLongPress={onLongPress} />);
    const target = screen.getByTestId('long-press-target');

    target.style.userSelect = 'text';
    (target.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = 'text';
    const setProperty = vi.spyOn(target.style, 'setProperty');
    const removeProperty = vi.spyOn(target.style, 'removeProperty');

    dispatchPointer(target, 'pointerdown');

    expect(target.style.userSelect).toBe('none');
    expect(webkitUserSelect(target)).toBe('none');
    expect(setProperty).toHaveBeenCalledWith('-webkit-touch-callout', 'none');

    act(() => vi.advanceTimersByTime(399));
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);

    dispatchPointer(target, 'pointerup');

    expect(target.style.userSelect).toBe('text');
    expect(webkitUserSelect(target)).toBe('text');
    expect(removeProperty).toHaveBeenCalledWith('-webkit-touch-callout');
  });

  it('prevents the next native touchend after a successful hold', () => {
    const onLongPress = vi.fn();
    render(<LongPressTarget onLongPress={onLongPress} />);
    const target = screen.getByTestId('long-press-target');

    dispatchPointer(target, 'pointerdown');
    act(() => vi.advanceTimersByTime(400));

    const touchEnd = new Event('touchend', { bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(touchEnd);
    });

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(touchEnd.defaultPrevented).toBe(true);
  });

  it('cancels when movement exceeds the tolerance and restores inline suppression', () => {
    const onLongPress = vi.fn();
    render(<LongPressTarget onLongPress={onLongPress} />);
    const target = screen.getByTestId('long-press-target');

    target.style.userSelect = 'text';
    (target.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = 'text';
    const removeProperty = vi.spyOn(target.style, 'removeProperty');

    dispatchPointer(target, 'pointerdown', { clientX: 10, clientY: 10 });
    dispatchPointer(target, 'pointermove', { clientX: 25, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));

    expect(onLongPress).not.toHaveBeenCalled();
    expect(target.style.userSelect).toBe('text');
    expect(webkitUserSelect(target)).toBe('text');
    expect(removeProperty).toHaveBeenCalledWith('-webkit-touch-callout');
  });

  it('skips interactive targets', () => {
    const onLongPress = vi.fn();
    render(<LongPressTarget onLongPress={onLongPress} />);
    const target = screen.getByTestId('long-press-target');
    const button = screen.getByRole('button', { name: 'Nested action' });

    dispatchPointer(button, 'pointerdown');
    act(() => vi.advanceTimersByTime(500));

    expect(onLongPress).not.toHaveBeenCalled();
    expect(target.style.userSelect).toBe('');
    expect(target.style.getPropertyValue('-webkit-touch-callout')).toBe('');
  });
});
