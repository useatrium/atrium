// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { SegmentedControl } from './SegmentedControl';

afterEach(cleanup);

describe('Button', () => {
  it('renders the primary variant recipe at md size by default', () => {
    render(<Button variant="primary">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toContain('bg-accent');
    expect(button.className).toContain('text-on-accent');
    expect(button.className).toContain('font-semibold');
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('rounded-md');
    // Defaults to a non-submitting button.
    expect(button.getAttribute('type')).toBe('button');
  });

  it('renders the secondary and ghost recipes and sm size', () => {
    const { rerender } = render(
      <Button variant="secondary" size="sm">
        A
      </Button>,
    );
    let button = screen.getByRole('button', { name: 'A' });
    expect(button.className).toContain('border-edge');
    expect(button.className).toContain('bg-surface-raised');
    expect(button.className).toContain('h-7');

    rerender(<Button variant="ghost">B</Button>);
    button = screen.getByRole('button', { name: 'B' });
    expect(button.className).not.toContain('border-edge');
    expect(button.className).toContain('text-fg-muted');
  });

  it('guards clicks when aria-disabled but stays focusable', () => {
    const onClick = vi.fn();
    render(
      <Button aria-disabled onClick={onClick}>
        Go
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires onClick when enabled', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('IconButton', () => {
  it('is a square ghost control by default with the required label', () => {
    render(
      <IconButton aria-label="Close">
        <svg />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button.className).toContain('size-7');
    expect(button.className).toContain('rounded-md');
    expect(button.className).toContain('place-items-center');
  });

  it('supports bordered, primary variants and the sm size', () => {
    const { rerender } = render(
      <IconButton aria-label="X" variant="bordered">
        <svg />
      </IconButton>,
    );
    let button = screen.getByRole('button', { name: 'X' });
    expect(button.className).toContain('border-edge');

    rerender(
      <IconButton aria-label="X" variant="primary" size="sm">
        <svg />
      </IconButton>,
    );
    button = screen.getByRole('button', { name: 'X' });
    expect(button.className).toContain('bg-accent');
    expect(button.className).toContain('size-6');
  });
});

describe('SegmentedControl', () => {
  const items = [
    { value: 'a' as const, label: 'A' },
    { value: 'b' as const, label: 'B' },
    { value: 'c' as const, label: 'C', disabled: true, tooltip: 'Nope' },
  ];

  it('renders a named group with one aria-pressed segment', () => {
    render(<SegmentedControl aria-label="Layout" value="b" onChange={() => {}} items={items} />);
    const group = screen.getByRole('group', { name: 'Layout' });
    expect(group.className).toContain('bg-surface');
    const a = screen.getByRole('button', { name: 'A' });
    const b = screen.getByRole('button', { name: 'B' });
    expect(a.getAttribute('aria-pressed')).toBe('false');
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.className).toContain('bg-surface-overlay');
  });

  it('calls onChange for an enabled segment and guards a disabled one', () => {
    const onChange = vi.fn();
    render(<SegmentedControl aria-label="Layout" value="a" onChange={onChange} items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
    const c = screen.getByRole('button', { name: 'C' });
    expect(c.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(c);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
