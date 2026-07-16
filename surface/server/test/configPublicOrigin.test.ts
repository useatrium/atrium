import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = process.env.ATRIUM_PUBLIC_ORIGIN;

async function configWithPublicOrigin(value: string | undefined) {
  if (value === undefined) delete process.env.ATRIUM_PUBLIC_ORIGIN;
  else process.env.ATRIUM_PUBLIC_ORIGIN = value;
  vi.resetModules();
  const { config } = await import('../src/config.js');
  return config;
}

afterEach(() => {
  if (saved === undefined) delete process.env.ATRIUM_PUBLIC_ORIGIN;
  else process.env.ATRIUM_PUBLIC_ORIGIN = saved;
  vi.resetModules();
});

describe('public origin env config', () => {
  it('is empty when ATRIUM_PUBLIC_ORIGIN is unset', async () => {
    expect((await configWithPublicOrigin(undefined)).publicOrigin).toBe('');
  });

  it('normalizes the configured HTTP(S) origin once', async () => {
    expect((await configWithPublicOrigin(' HTTPS://ATRIUM.EXAMPLE:443/ ')).publicOrigin).toBe('https://atrium.example');
    expect((await configWithPublicOrigin('http://atrium.example:3001/')).publicOrigin).toBe(
      'http://atrium.example:3001',
    );
  });

  it.each([
    'not a URL',
    'ftp://atrium.example',
    'https://atrium.example/path',
    'https://atrium.example?mode=bad',
  ])('rejects malformed or non-origin value %s at config load', async (value) => {
    await expect(configWithPublicOrigin(value)).rejects.toThrow('ATRIUM_PUBLIC_ORIGIN must be a valid HTTP(S) origin');
  });
});
