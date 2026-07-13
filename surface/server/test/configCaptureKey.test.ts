// Pins the server's side of the node-sync seam env contract
// (runtime/node-sync/contract/contract.toml [env.server]): the capture key is
// read from ARTIFACT_CAPTURE_API_KEY, with the canonical ATRIUM_CAPTURE_API_KEY
// accepted as a fallback. Without this test, a server-side env rename would
// leave every contract lane green while the daemon's calls 401 in production.
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['ARTIFACT_CAPTURE_API_KEY', 'ATRIUM_CAPTURE_API_KEY'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function configWith(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const { config } = await import('../src/config.js');
  return config;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

describe('capture key env contract (node-sync seam)', () => {
  it('reads the historical spelling first', async () => {
    const config = await configWith({
      ARTIFACT_CAPTURE_API_KEY: 'historical',
      ATRIUM_CAPTURE_API_KEY: 'canonical',
    });
    expect(config.artifactCaptureApiKey).toBe('historical');
  });

  it('accepts the canonical spelling as a fallback', async () => {
    const config = await configWith({ ATRIUM_CAPTURE_API_KEY: 'canonical' });
    expect(config.artifactCaptureApiKey).toBe('canonical');
  });

  it('is empty when neither spelling is set', async () => {
    const config = await configWith({});
    expect(config.artifactCaptureApiKey).toBe('');
  });
});
