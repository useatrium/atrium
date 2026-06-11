export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium',
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '127.0.0.1',
  // Prototype-grade: dev default secret; override in any real deployment.
  sessionSecret: process.env.SESSION_SECRET ?? 'atrium-dev-secret-change-me',
  sessionCookie: 'atrium_session',
  maxMessageBytes: 8 * 1024,
  centaurBaseUrl: process.env.CENTAUR_BASE_URL ?? 'http://127.0.0.1:18000',
  centaurApiKey: process.env.CENTAUR_API_KEY ?? '',
  centaurHarness: process.env.CENTAUR_HARNESS ?? 'claude-code',
  // File uploads (MinIO in dev; any S3-compatible store in deployment).
  s3Endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  s3Bucket: process.env.S3_BUCKET ?? 'atrium-files',
  s3AccessKey: process.env.S3_ACCESS_KEY ?? 'atrium',
  s3SecretKey: process.env.S3_SECRET_KEY ?? 'atrium-dev-secret',
  maxUploadBytes: 25 * 1024 * 1024,
  pushRedactContent: process.env.PUSH_REDACT === '1',
};
