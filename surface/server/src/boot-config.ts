export interface BootConfiguration {
  nodeEnv: string;
  listenHost: string;
  listenPort: number;
  serverPublicationBindHost: string | null;
  objectStoragePublicationBindHost: string | null;
  databasePublicationBindHost: string | null;
  serverPublicationPort: string;
  objectStoragePublicationPort: string;
  databasePublicationPort: string;
  artifactCaptureApiKey: string;
}

function isWildcardBind(host: string | null): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

export function effectiveBindAddresses(config: BootConfiguration): Record<string, string> {
  const serverBindHost = config.serverPublicationBindHost ?? 'not provided';
  const objectStorageBindHost = config.objectStoragePublicationBindHost ?? 'not provided';
  const databaseBindHost = config.databasePublicationBindHost ?? 'not provided';
  return {
    serverListen: `${config.listenHost}:${config.listenPort}`,
    serverPublication: `${serverBindHost}:${config.serverPublicationPort}`,
    objectStoragePublication: `${objectStorageBindHost}:${config.objectStoragePublicationPort}`,
    databasePublication: `${databaseBindHost}:${config.databasePublicationPort}`,
  };
}

/**
 * Production-only deployment guards. Tests and local `pnpm dev` do not set
 * NODE_ENV=production, and direct app construction never calls this boot path.
 */
export function validateBootConfiguration(config: BootConfiguration): void {
  if (config.nodeEnv !== 'production') return;

  const errors: string[] = [];
  const wildcardServer = isWildcardBind(config.serverPublicationBindHost);
  const wildcardObjectStorage = isWildcardBind(config.objectStoragePublicationBindHost);
  if (
    wildcardServer &&
    wildcardObjectStorage &&
    config.serverPublicationBindHost === config.objectStoragePublicationBindHost
  ) {
    errors.push(
      `unsafe service publication bind: BIND_HOST=${config.objectStoragePublicationBindHost} publishes the Surface server and MinIO on every host interface; set BIND_HOST=127.0.0.1`,
    );
  } else {
    if (wildcardServer) {
      errors.push(
        `unsafe server publication bind: BIND_HOST=${config.serverPublicationBindHost} publishes the Surface server on every host interface; set BIND_HOST=127.0.0.1 or use a private interface address`,
      );
    }
    if (wildcardObjectStorage) {
      errors.push(
        `unsafe object storage publication bind: BIND_HOST=${config.objectStoragePublicationBindHost} publishes MinIO on every host interface; set BIND_HOST=127.0.0.1`,
      );
    }
  }
  if (isWildcardBind(config.databasePublicationBindHost)) {
    errors.push(
      `unsafe database publication bind: DB_BIND_HOST=${config.databasePublicationBindHost} publishes Postgres on every host interface; set DB_BIND_HOST=127.0.0.1`,
    );
  }
  if (config.artifactCaptureApiKey.trim() === '') {
    errors.push('artifact capture is not authenticated — set ARTIFACT_CAPTURE_API_KEY on both the Surface and Centaur');
  }

  if (errors.length > 0) {
    throw new Error(`production configuration invalid:\n- ${errors.join('\n- ')}`);
  }
}
