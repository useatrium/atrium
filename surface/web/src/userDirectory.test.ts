// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement, Fragment, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const usersMock = vi.hoisted(() => vi.fn());

vi.mock('./api', () => ({ api: { users: usersMock } }));

import { clearUserDirectoryForTests, useUserDirectory } from './userDirectory';

const ID = 'a15f10f7-89b0-44c9-903f-d488d21bb73c';
const TEXT = `hello <@${ID}> there`;
const USER = { id: ID, handle: 'allan', displayName: 'Allan Niemerg' };
const ABSENT_TTL_MS = 5 * 60_000;

let forceRender: (() => void) | null = null;

function Probe({ text = TEXT }: { text?: string }) {
  const { resolve } = useUserDirectory(text);
  return createElement('span', { 'data-testid': 'label' }, resolve(ID)?.displayName ?? 'unknown');
}

function Rerenderer({ count = 1 }: { count?: number }) {
  const [, setTick] = useState(0);
  forceRender = () => setTick((tick) => tick + 1);
  return createElement(
    Fragment,
    null,
    Array.from({ length: count }, (_, index) => createElement(Probe, { key: index })),
  );
}

function label() {
  return screen.getAllByTestId('label')[0]?.textContent;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function rerender() {
  await act(async () => {
    forceRender?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
  clearUserDirectoryForTests();
  usersMock.mockReset();
  forceRender = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('user directory retries', () => {
  it('T1: resolves a healthy load with one request', async () => {
    usersMock.mockResolvedValue({ users: [USER] });

    render(createElement(Probe));
    await settle();

    expect(label()).toBe('Allan Niemerg');
    expect(usersMock).toHaveBeenCalledTimes(1);
  });

  it('T2: retries one failure after the backoff and heals', async () => {
    usersMock.mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({ users: [USER] });

    render(createElement(Rerenderer));
    await settle();
    expect(label()).toBe('unknown');
    expect(usersMock).toHaveBeenCalledTimes(1);

    advance(999);
    await rerender();
    expect(usersMock).toHaveBeenCalledTimes(1);

    advance(1);
    await rerender();
    expect(label()).toBe('Allan Niemerg');
    expect(usersMock).toHaveBeenCalledTimes(2);
  });

  it('T3: heals after two failures without a page reload', async () => {
    usersMock
      .mockRejectedValueOnce(new Error('restart 1'))
      .mockRejectedValueOnce(new Error('restart 2'))
      .mockResolvedValue({ users: [USER] });

    render(createElement(Rerenderer));
    await settle();
    expect(usersMock).toHaveBeenCalledTimes(1);

    advance(1000);
    await rerender();
    expect(label()).toBe('unknown');
    expect(usersMock).toHaveBeenCalledTimes(2);

    advance(1999);
    await rerender();
    expect(usersMock).toHaveBeenCalledTimes(2);

    advance(1);
    await rerender();
    expect(label()).toBe('Allan Niemerg');
    expect(usersMock).toHaveBeenCalledTimes(3);
  });

  it('T4: rechecks an absent user after a successful incomplete load', async () => {
    usersMock.mockResolvedValueOnce({ users: [] }).mockResolvedValue({ users: [USER] });

    render(createElement(Probe));
    await settle();

    expect(label()).toBe('Allan Niemerg');
    expect(usersMock).toHaveBeenCalledTimes(2);
  });

  it('T5: deduplicates 50+ rows to one request per backoff window', async () => {
    usersMock.mockRejectedValue(new Error('server down'));

    render(createElement(Rerenderer, { count: 60 }));
    await settle();
    expect(label()).toBe('unknown');
    expect(usersMock).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 10; index++) await rerender();
    advance(999);
    for (let index = 0; index < 10; index++) await rerender();
    expect(usersMock).toHaveBeenCalledTimes(1);

    advance(1);
    for (let index = 0; index < 10; index++) await rerender();
    expect(usersMock).toHaveBeenCalledTimes(2);

    advance(1999);
    for (let index = 0; index < 10; index++) await rerender();
    expect(usersMock).toHaveBeenCalledTimes(2);

    advance(1);
    for (let index = 0; index < 10; index++) await rerender();
    expect(label()).toBe('unknown');
    expect(usersMock).toHaveBeenCalledTimes(3);
  });

  it('T6: rechecks a genuinely unknown id at most once per absent TTL', async () => {
    usersMock.mockResolvedValue({ users: [] });

    render(createElement(Rerenderer));
    await settle();
    expect(label()).toBe('unknown');
    expect(usersMock).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 10; index++) await rerender();
    advance(ABSENT_TTL_MS - 1);
    for (let index = 0; index < 10; index++) await rerender();
    expect(usersMock).toHaveBeenCalledTimes(2);

    advance(1);
    await rerender();
    expect(label()).toBe('unknown');
    expect(usersMock).toHaveBeenCalledTimes(3);
  });

  it('T8: a malformed 200 is a failure, not a permanent wedge', async () => {
    // `/api/users` serves ETag/304s, so an empty or shape-changed body is reachable:
    // `users` is undefined, primeUserDirectory throws. That must land in the retry path.
    // With `.then(onOk, onErr)` it did not, and status stayed 'loading' forever — one
    // request, '@unknown', no recovery. Exactly the bug this module is meant to fix.
    usersMock.mockResolvedValueOnce({} as never).mockResolvedValue({ users: [USER] });

    render(createElement(Rerenderer));
    await settle();
    expect(label()).toBe('unknown');
    expect(usersMock).toHaveBeenCalledTimes(1);

    advance(1000);
    await rerender();

    expect(label()).toBe('Allan Niemerg');
    expect(usersMock).toHaveBeenCalledTimes(2);
  });

  it('T7: follows 1s, 2s, 4s, 8s, 30s backoff capped at 30s', async () => {
    usersMock.mockRejectedValue(new Error('server down'));
    render(createElement(Rerenderer));
    await settle();
    expect(usersMock).toHaveBeenCalledTimes(1);

    const delays = [1000, 2000, 4000, 8000, 30000, 30000];
    for (const [index, delay] of delays.entries()) {
      advance(delay - 1);
      await rerender();
      expect(usersMock).toHaveBeenCalledTimes(index + 1);

      advance(1);
      await rerender();
      expect(usersMock).toHaveBeenCalledTimes(index + 2);
    }

    expect(label()).toBe('unknown');
    expect(usersMock).toHaveBeenCalledTimes(7);
  });
});
