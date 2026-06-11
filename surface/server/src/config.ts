export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium',
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '127.0.0.1',
  // Prototype-grade: dev default secret; override in any real deployment.
  sessionSecret: process.env.SESSION_SECRET ?? 'atrium-dev-secret-change-me',
  sessionCookie: 'atrium_session',
  authOpen: (process.env.AUTH_OPEN ?? '1') !== '0',
  authDevCodes: (process.env.AUTH_DEV_CODES ?? '0') === '1',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRedirectUrl: process.env.GOOGLE_REDIRECT_URL ?? '',
  // EMAIL_MODE: "log" (dev) or "resend" (HTTP API). EMAIL_FROM + RESEND_API_KEY
  // required for resend. SMTP is a future branch in email.ts.
  emailMode: ((process.env.EMAIL_MODE ?? 'log') === 'resend' ? 'resend' : 'log') as
    | 'log'
    | 'resend',
  emailFrom: process.env.EMAIL_FROM ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
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
