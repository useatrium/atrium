import { describe, expect, it } from 'vitest';
import { maxSessionStatus } from './sessions';

describe('maxSessionStatus', () => {
  it('keeps completed ahead of failed regardless of event order', () => {
    expect(maxSessionStatus('completed', 'failed')).toBe('completed');
    expect(maxSessionStatus('failed', 'completed')).toBe('completed');
  });

  it('ranks completed ahead of cancelled', () => {
    expect(maxSessionStatus('completed', 'cancelled')).toBe('completed');
  });

  it('ranks completed ahead of running', () => {
    expect(maxSessionStatus('running', 'completed')).toBe('completed');
  });
});
