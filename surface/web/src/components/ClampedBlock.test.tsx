// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
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
    <ClampedBlock
      collapsedClassName="test-clamp"
      overflowingClassName="test-fade"
      expandLabel="Show more ↓"
      collapseLabel="Show less ↑"
    >
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

  // The fade advertises "there is more below". Content that fits gets no toggle,
  // so a fade there would point at nothing and the user would have no control to
  // clear it — the message would just render permanently dimmed.
  it('withholds the overflow hint from content that fits, alongside the toggle', () => {
    const { container } = renderClamp();
    const content = container.querySelector('.test-clamp');
    setMetrics(content!, 80, 80);

    act(() => observers[0]?.trigger());

    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.test-fade')).toBeNull();
  });

  it('applies the overflow hint while clamped content overflows', () => {
    const { container } = renderClamp();
    const content = container.querySelector('.test-clamp');
    setMetrics(content!, 180, 80);

    act(() => observers[0]?.trigger());

    expect(container.querySelector('.test-fade')).toBeTruthy();

    // Expanding drops the hint with the constraint: nothing is hidden any more.
    fireEvent.click(screen.getByRole('button', { name: 'Show more ↓' }));
    expect(container.querySelector('.test-fade')).toBeNull();
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

describe('ClampedBlock boundary identity', () => {
  it('does not remount clamped content when the clamp re-renders', () => {
    let mounts = 0;
    function Child() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <span>Child</span>;
    }

    const { rerender } = render(
      <ClampedBlock collapsedClassName="test-clamp" expandLabel="Show more ↓" collapseLabel="Show less ↑">
        <Child />
      </ClampedBlock>,
    );
    expect(mounts).toBe(1);

    rerender(
      <ClampedBlock collapsedClassName="test-clamp" expandLabel="Show all ↓" collapseLabel="Show less ↑">
        <Child />
      </ClampedBlock>,
    );

    expect(mounts).toBe(1);
  });
});

describe('clamp containing blocks', () => {
  // #544: `overflow: hidden` only clips descendants whose containing block runs
  // through the clamping box. A `position: absolute` descendant (Tailwind's
  // `sr-only`, which GFM footnotes and CriticMarkupView both emit) otherwise
  // anchors to a positioned ancestor ABOVE the clamp, escapes the clip, and
  // drags the scroll height into thousands of px of blank space. Every clamp in
  // the app that can hold rendered markup must therefore be `relative`.
  it('every collapsed clamp class in the app declares position: relative', async () => {
    const sources = import.meta.glob('/src/**/*.tsx', { as: 'raw', eager: true }) as Record<string, string>;
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (path.includes('ClampedBlock')) continue;
      // Matches both the primitive's prop and hand-rolled clamp class strings.
      const clampClasses = source.match(/(?:collapsedClassName=")([^"]*)"/g) ?? [];
      for (const match of clampClasses) {
        const value = match.slice('collapsedClassName="'.length, -1);
        const clips = value.includes('overflow-hidden') || value.includes('line-clamp-');
        if (clips && !value.split(/\s+/).includes('relative')) offenders.push(`${path}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
