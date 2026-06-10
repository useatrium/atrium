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
};
