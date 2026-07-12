import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { config } from './config.js';
import { appAssetMime, AppRegistry, normalizeAppRelPath } from './app-registry.js';
import { verifyAppLaunchSignature } from './app-signing.js';
import { getObjectStream } from './s3.js';

export interface AppsOriginDeps {
  pool: Db;
  signingSecret?: string;
  storage?: {
    getObjectStream(key: string): Promise<NodeJS.ReadableStream | { stream: NodeJS.ReadableStream }>;
  };
}

export async function buildAppsOrigin(deps: AppsOriginDeps): Promise<FastifyInstance> {
  const signingSecret = deps.signingSecret ?? config.appSigningSecret;
  const storage = deps.storage ?? { getObjectStream };
  const registry = new AppRegistry(deps.pool, {
    appsOrigin: config.appsOrigin,
    signingSecret,
    launchTtlSeconds: config.appsLaunchTtlSeconds,
  });
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  app.get('/apps/:appId/v/:version/g/:exp/:sig/*', async (req, reply) => {
    const params = req.params as {
      appId: string;
      version: string;
      exp: string;
      sig: string;
      '*': string;
    };
    const version = Number(params.version);
    const expires = Number(params.exp);
    let relPath: string;
    try {
      relPath = normalizeAppRelPath(params['*'] || 'index.html');
    } catch {
      return reply.code(400).send({ error: 'bad_app_path', message: 'app path must be relative' });
    }
    const ok = verifyAppLaunchSignature(
      { appId: params.appId, version, relPath: '*', expires },
      params.sig,
      signingSecret,
    );
    if (!ok) {
      return reply.code(401).send({ error: 'unauthorized', message: 'invalid app launch signature' });
    }
    const file = await registry.resolveFile(params.appId, version, relPath);
    if (!file) return reply.code(404).send({ error: 'not_found', message: 'app file not found' });

    reply.header('Content-Type', appAssetMime(file.relPath, file.mime));
    reply.header('Content-Length', String(file.sizeBytes));
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    reply.header('X-App-Id', file.appId);
    reply.header('X-App-Version', String(file.version));
    reply.header('X-App-Blob-Sha', file.blobSha);
    const object = await storage.getObjectStream(file.s3Key);
    return reply.send('stream' in object ? object.stream : object);
  });

  return app;
}
