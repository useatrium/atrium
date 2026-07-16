// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClampedBlock } from './ClampedBlock';

const observers: MockResizeObserver[] = [];

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }

  observe(_target: Element) {}

  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function setMetrics(element: Element, scrollHeight: number, clientHeight: number) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  });
}

function renderClamp(children: React.ReactNode = 'Content') {
  return render(
    <ClampedBlock collapsedClassName="test-clamp" expandLabel="Show more ↓" collapseLabel="Show less ↑">
      {children}
    </ClampedBlock>,
  );
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ClampedBlock', () => {
  it('does not show a toggle when the clamped content does not overflow', () => {
    const { container } = renderClamp();
    const content = container.querySelector('.test-clamp');
    expect(content).toBeTruthy();
    setMetrics(content!, 80, 80);

    act(() => observers[0]?.trigger());

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('toggles its caller-supplied label and expansion direction', () => {
    const { container } = renderClamp();
    const content = container.querySelector('.test-clamp');
    expect(content).toBeTruthy();
    setMetrics(content!, 180, 80);
    act(() => observers[0]?.trigger());

    const expand = screen.getByRole('button', { name: 'Show more ↓' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);

    const collapse = screen.getByRole('button', { name: 'Show less ↑' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.test-clamp')).toBeNull();
  });

  it('disables a nested clamp so only the outer block can collapse', () => {
    const { container } = renderClamp(
      <ClampedBlock collapsedClassName="nested-clamp" expandLabel="Expand nested" collapseLabel="Collapse nested">
        Nested content
      </ClampedBlock>,
    );

    expect(container.querySelector('.test-clamp')).toBeTruthy();
    expect(container.querySelector('.nested-clamp')).toBeNull();
    expect(observers).toHaveLength(1);
  });
});
