function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium',
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '127.0.0.1',
  // Prototype-grade: dev default secret; override in any real deployment.
  sessionSecret: process.env.SESSION_SECRET ?? 'atrium-dev-secret-change-me',
  providerCredentialSecret:
    process.env.PROVIDER_CREDENTIAL_SECRET ?? process.env.SESSION_SECRET ?? 'atrium-dev-secret-change-me',
  sessionCookie: 'atrium_session',
  // Cross-origin allowlist for non-same-origin clients (the Electron desktop
  // shell loads from app://atrium and calls this server with a bearer token).
  // Comma-separated; token auth carries no cookies, so this never enables
  // credentialed CORS. The web SPA is same-origin and never triggers it.
  corsOrigins: (process.env.ATRIUM_CORS_ORIGINS ?? 'app://atrium')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  authOpen: (process.env.AUTH_OPEN ?? '1') !== '0',
  fullViewEnabled: (process.env.ATRIUM_FULL_VIEW ?? '0') === '1',
  authDevCodes: (process.env.AUTH_DEV_CODES ?? '0') === '1',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRedirectUrl: process.env.GOOGLE_REDIRECT_URL ?? '',
  // EMAIL_MODE: "log" (dev) or "resend" (HTTP API). EMAIL_FROM + RESEND_API_KEY
  // required for resend. SMTP is a future branch in email.ts.
  emailMode: ((process.env.EMAIL_MODE ?? 'log') === 'resend' ? 'resend' : 'log') as 'log' | 'resend',
  emailFrom: process.env.EMAIL_FROM ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  rateLimitEnabled: process.env.ATRIUM_RATE_LIMIT !== '0',
  rateLimitMax: positiveIntEnv('ATRIUM_RATE_LIMIT_MAX', 600),
  rateLimitLoginMax: positiveIntEnv('ATRIUM_RATE_LIMIT_LOGIN_MAX', 30),
  maxMessageBytes: 8 * 1024,
  sessionAutoArchiveDays: nonNegativeIntEnv('ATRIUM_SESSION_AUTO_ARCHIVE_DAYS', 14),
  centaurBaseUrl: process.env.CENTAUR_BASE_URL ?? 'http://127.0.0.1:18000',
  centaurApiKey: process.env.CENTAUR_API_KEY ?? '',
  centaurHarness: process.env.CENTAUR_HARNESS ?? 'codex',
  ironControlBaseUrl: process.env.IRON_CONTROL_BASE_URL ?? '',
  ironControlApiKey: process.env.IRON_CONTROL_API_KEY ?? '',
  ironControlNamespace: process.env.IRON_CONTROL_NAMESPACE ?? 'default',
  // Codex "Sign in with ChatGPT" device authorization grant. The public client
  // id + issuer are the codex CLI's own (openai/codex codex-rs/login), reused so
  // the tokens are genuine subscription tokens (aud includes chatgpt.com/backend-api).
  codexOauthClientId: process.env.CODEX_OAUTH_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann',
  codexOauthIssuer: process.env.CODEX_OAUTH_ISSUER ?? 'https://auth.openai.com',
  // Claude Code OAuth (authorization-code + PKCE, Anthropic hosted-callback code
  // paste). Client id is Claude Code's public client; scope user:inference yields
  // the ~1-year long-lived token (same flow `claude setup-token` runs).
  claudeOauthClientId: process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  claudeOauthAuthorizeUrl: process.env.CLAUDE_OAUTH_AUTHORIZE_URL ?? 'https://claude.com/cai/oauth/authorize',
  claudeOauthTokenUrl: process.env.CLAUDE_OAUTH_TOKEN_URL ?? 'https://platform.claude.com/v1/oauth/token',
  claudeOauthRedirectUri: process.env.CLAUDE_OAUTH_REDIRECT_URI ?? 'https://platform.claude.com/oauth/code/callback',
  githubAppClientId: process.env.GITHUB_APP_CLIENT_ID ?? '',
  githubAppClientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? '',
  githubAppRedirectUrl: process.env.GITHUB_APP_REDIRECT_URL ?? '',
  githubAppId: process.env.GITHUB_APP_ID ?? '',
  githubAppPrivateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  githubAppPrivateKeyId: process.env.GITHUB_APP_PRIVATE_KEY_ID ?? '',
  // Pins which App installation backs the shared `github-default` fallback role.
  // Unset auto-discovers, but only when the App has exactly one installation.
  githubAppFallbackInstallationId: process.env.GITHUB_APP_FALLBACK_INSTALLATION_ID ?? '',
  githubPublicReadToken: process.env.GITHUB_PUBLIC_READ_TOKEN ?? '',
  // The Centaur artifact-byte endpoint authenticates with its own
  // sandbox-token key, distinct from CENTAUR_API_KEY. Unset falls back to
  // centaurApiKey (works only if Centaur accepts the session key there).
  artifactCaptureApiKey: process.env.ARTIFACT_CAPTURE_API_KEY ?? '',
  // === gc additions ===
  artifactGcEnabled: process.env.ARTIFACT_GC_ENABLED === '1',
  artifactGcIntervalMs: Number(process.env.ARTIFACT_GC_INTERVAL_MS ?? 300_000),
  artifactGcGraceMs: Number(process.env.ARTIFACT_GC_GRACE_MS ?? 3_600_000),
  artifactRetentionMs: Number(process.env.ARTIFACT_RETENTION_MS ?? 30 * 24 * 3_600_000),
  artifactGcBatchSize: Number(process.env.ARTIFACT_GC_BATCH_SIZE ?? 50),
  warmcacheEvictTtlDays: positiveIntEnv('WARMCACHE_EVICT_TTL_DAYS', 30),
  warmcacheWorkspaceSizeCapBytes: positiveIntEnv('WARMCACHE_WORKSPACE_SIZE_CAP_BYTES', 50 * 1024 ** 3),
  appSigningSecret:
    process.env.APP_SIGNING_SECRET ?? process.env.SESSION_SECRET ?? 'atrium-dev-app-signing-secret-change-me',
  appsOrigin: process.env.APPS_ORIGIN ?? 'http://127.0.0.1:3201',
  appsPort: Number(process.env.APPS_PORT ?? 0),
  appsHost: process.env.APPS_HOST ?? process.env.HOST ?? '127.0.0.1',
  appsLaunchTtlSeconds: positiveIntEnv('APPS_LAUNCH_TTL_SECONDS', 300),
  // File uploads (MinIO in dev; any S3-compatible store in deployment).
  s3Endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  s3InternalEndpoint: process.env.S3_INTERNAL_ENDPOINT ?? process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  s3Bucket: process.env.S3_BUCKET ?? 'atrium-files',
  s3AccessKey: process.env.S3_ACCESS_KEY ?? 'atrium',
  s3SecretKey: process.env.S3_SECRET_KEY ?? 'atrium-dev-secret',
  maxUploadBytes: 25 * 1024 * 1024,
  pushRedactContent: process.env.PUSH_REDACT === '1',
  questionRenotifyMinutes: Number(process.env.QUESTION_RENOTIFY_MINUTES ?? 10),
  // === server-push additions ===
  // Standard base64url P-256 VAPID keys, as emitted by `web-push generate-vapid-keys`.
  // Leave any value unset to disable Web Push delivery while preserving registration.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? '',
  // LiveKit calls are optional infra. Leave any of these unset to keep call
  // endpoints disabled while the rest of the server boots normally.
  livekitUrl: process.env.LIVEKIT_URL ?? '',
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  // VoIP push infra is optional. Leave APNs and/or FCM unset to skip that
  // platform while preserving foreground WS call ringing.
  apnsTeamId: process.env.APNS_TEAM_ID ?? '',
  apnsKeyId: process.env.APNS_KEY_ID ?? '',
  apnsAuthKeyP8: process.env.APNS_AUTH_KEY_P8 ?? '',
  apnsBundleId: process.env.APNS_BUNDLE_ID ?? '',
  // Dev/debug builds register APNs *sandbox* tokens — set APNS_SANDBOX=1 to send
  // via api.sandbox.push.apple.com. Default (unset): production host.
  apnsSandbox: ['1', 'true'].includes((process.env.APNS_SANDBOX ?? '').toLowerCase()),
  fcmProjectId: process.env.FCM_PROJECT_ID ?? '',
  fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON ?? '',
};
