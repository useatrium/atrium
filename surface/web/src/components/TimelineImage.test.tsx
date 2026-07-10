// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getTimelineImageDisplayBox, TimelineImage } from './TimelineImage';

afterEach(() => {
  cleanup();
});

describe('getTimelineImageDisplayBox', () => {
  it('clamps wide images to 384px', () => {
    expect(getTimelineImageDisplayBox(2000, 1000)).toEqual({
      displayWidth: 384,
      aspectRatio: 2,
      source: 'intrinsic',
    });
  });

  it('clamps tall images to a 288px display height', () => {
    expect(getTimelineImageDisplayBox(600, 1200)).toEqual({
      displayWidth: 144,
      aspectRatio: 0.5,
      source: 'intrinsic',
    });
  });

  it('keeps small images at natural size', () => {
    expect(getTimelineImageDisplayBox(120, 90)).toEqual({
      displayWidth: 120,
      aspectRatio: 4 / 3,
      source: 'intrinsic',
    });
  });

  it('reserves a 4:3 fallback box without dimensions', () => {
    expect(getTimelineImageDisplayBox()).toEqual({
      displayWidth: 'min(384px, 100%)',
      aspectRatio: 4 / 3,
      source: 'fallback',
    });
  });
});

describe('TimelineImage', () => {
  it('adjusts an unknown-size fallback box after the image load event', () => {
    render(<TimelineImage src="/late.png" alt="late image" loading="lazy" />);

    const image = screen.getByRole('img', { name: 'late image' }) as HTMLImageElement;
    expect(image.style.width).toBe('min(384px, 100%)');
    expect(image.style.aspectRatio).toBe(`${4 / 3}`);

    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 400 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 800 });
    fireEvent.load(image);

    expect(image.style.width).toBe('144px');
    expect(image.style.aspectRatio).toBe('0.5');
  });
});
