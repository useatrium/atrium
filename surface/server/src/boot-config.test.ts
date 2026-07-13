import { describe, expect, it } from 'vitest';
import { effectiveBindAddresses, type BootConfiguration, validateBootConfiguration } from './boot-config.js';

const safeProductionConfig: BootConfiguration = {
  nodeEnv: 'production',
  listenHost: '0.0.0.0',
  listenPort: 3001,
  serverPublicationBindHost: '127.0.0.1',
  objectStoragePublicationBindHost: '127.0.0.1',
  databasePublicationBindHost: '127.0.0.1',
  serverPublicationPort: '3001',
  objectStoragePublicationPort: '9000',
  databasePublicationPort: '5433',
  artifactCaptureApiKey: 'capture-secret',
};

describe('production boot configuration', () => {
  it('accepts loopback publications and an authenticated artifact capture seam', () => {
    expect(() => validateBootConfiguration(safeProductionConfig)).not.toThrow();
  });

  it.each(['0.0.0.0', '::', '[::]'])('rejects wildcard service publication %s', (publicationBindHost) => {
    expect(() =>
      validateBootConfiguration({
        ...safeProductionConfig,
        serverPublicationBindHost: publicationBindHost,
        objectStoragePublicationBindHost: publicationBindHost,
      }),
    ).toThrow(
      `unsafe service publication bind: BIND_HOST=${publicationBindHost} publishes the Surface server and MinIO on every host interface; set BIND_HOST=127.0.0.1`,
    );
  });

  it('rejects a wildcard object-storage publication even when the server uses a private interface', () => {
    expect(() =>
      validateBootConfiguration({ ...safeProductionConfig, objectStoragePublicationBindHost: '0.0.0.0' }),
    ).toThrow(
      'unsafe object storage publication bind: BIND_HOST=0.0.0.0 publishes MinIO on every host interface; set BIND_HOST=127.0.0.1',
    );
  });

  it('rejects a wildcard Postgres publication', () => {
    expect(() =>
      validateBootConfiguration({ ...safeProductionConfig, databasePublicationBindHost: '0.0.0.0' }),
    ).toThrow(
      'unsafe database publication bind: DB_BIND_HOST=0.0.0.0 publishes Postgres on every host interface; set DB_BIND_HOST=127.0.0.1',
    );
  });

  it.each(['', '   '])('rejects an empty artifact capture key (%j)', (artifactCaptureApiKey) => {
    expect(() => validateBootConfiguration({ ...safeProductionConfig, artifactCaptureApiKey })).toThrow(
      'artifact capture is not authenticated — set ARTIFACT_CAPTURE_API_KEY on both the Surface and Centaur',
    );
  });

  it('reports every production error in one boot failure', () => {
    expect(() =>
      validateBootConfiguration({
        ...safeProductionConfig,
        serverPublicationBindHost: '0.0.0.0',
        objectStoragePublicationBindHost: '0.0.0.0',
        databasePublicationBindHost: '::',
        artifactCaptureApiKey: '',
      }),
    ).toThrow(
      /unsafe service publication bind[\s\S]*unsafe database publication bind[\s\S]*artifact capture is not authenticated/,
    );
  });

  it.each(['development', 'test', ''])('does not apply production guards in %j', (nodeEnv) => {
    expect(() =>
      validateBootConfiguration({
        ...safeProductionConfig,
        nodeEnv,
        serverPublicationBindHost: '0.0.0.0',
        objectStoragePublicationBindHost: '0.0.0.0',
        databasePublicationBindHost: '0.0.0.0',
        artifactCaptureApiKey: '',
      }),
    ).not.toThrow();
  });

  it('describes the internal listener separately from effective host publications', () => {
    expect(effectiveBindAddresses(safeProductionConfig)).toEqual({
      serverListen: '0.0.0.0:3001',
      serverPublication: '127.0.0.1:3001',
      objectStoragePublication: '127.0.0.1:9000',
      databasePublication: '127.0.0.1:5433',
    });
  });
});
