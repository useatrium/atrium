import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('S3 endpoint split', () => {
  it('presigns with the public endpoint and keeps internal byte I/O on the internal endpoint', async () => {
    vi.stubEnv('S3_ENDPOINT', 'https://public-storage.example.test');
    vi.stubEnv('S3_INTERNAL_ENDPOINT', 'http://internal-minio:9000');
    vi.stubEnv('S3_BUCKET', 'atrium-test-files');
    vi.stubEnv('S3_ACCESS_KEY', 'test-access-key');
    vi.stubEnv('S3_SECRET_KEY', 'test-secret-key');
    vi.resetModules();

    const { internalClient, presignGet, presignPut } = await import('../src/s3.js');

    const putUrl = await presignPut('uploads/example.txt', 'text/plain');
    const getUrl = await presignGet('uploads/example.txt', 'example.txt', true);
    const internalEndpoint = await internalClient.config.endpoint?.();

    expect(new URL(putUrl).host).toBe('public-storage.example.test');
    expect(new URL(getUrl).host).toBe('public-storage.example.test');
    expect(internalEndpoint?.protocol).toBe('http:');
    expect(internalEndpoint?.hostname).toBe('internal-minio');
    expect(internalEndpoint?.port).toBe(9000);
  });
});
