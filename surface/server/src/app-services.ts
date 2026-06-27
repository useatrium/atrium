import { CentaurClient } from '@atrium/centaur-client';
import { AgentProfiles } from './agent-profiles.js';
import { AppRegistry } from './app-registry.js';
import { config } from './config.js';
import type { Db } from './db.js';
import { DemoCentaurClient } from './demo-centaur.js';
import { WsHub } from './hub.js';
import type { CallTokenService } from './livekit.js';
import { createLiveKitTokenService } from './livekit.js';
import { ProviderCredentials } from './provider-credentials.js';
import { deleteObject, ensureBucket, getObjectBytes, presignGet, presignPut } from './s3.js';
import { SessionRuns, type SessionRunsOptions } from './session-runs.js';
import { getVoipSender, type VoipPushSender } from './voip.js';

export type FileStorageDeps = {
  ensureBucket: typeof ensureBucket;
  deleteObject: typeof deleteObject;
  presignGet: typeof presignGet;
  presignPut: typeof presignPut;
};

export interface AppServiceDeps {
  pool: Db;
  hub?: WsHub;
  sessionSecret?: string;
  sessionRuns?: SessionRunsOptions;
  fileStorage?: FileStorageDeps;
  /** Injectable in tests; false keeps call endpoints explicitly unconfigured. */
  calls?: false | CallTokenService;
  /** Injectable in tests; defaults to env-selected APNs/FCM/noop transport. */
  voip?: VoipPushSender;
  /** Injectable fetch for the email transport (tests mock Resend). */
  emailFetch?: typeof fetch;
  /** Internal x-api-key override for tests; production reads config. */
  artifactCaptureApiKey?: string;
}

export interface AppServices {
  agentProfiles: AgentProfiles;
  appRegistry: AppRegistry;
  artifactCaptureApiKey: string | undefined;
  calls: CallTokenService | null;
  emailFetch: typeof fetch | undefined;
  fileStorage: FileStorageDeps;
  hub: WsHub;
  providerCredentials: ProviderCredentials;
  secret: string;
  sessionRuns: SessionRuns;
  voip: VoipPushSender;
}

export function createAppServices(deps: AppServiceDeps): AppServices {
  const { pool } = deps;
  const hub = deps.hub ?? new WsHub();
  const secret = deps.sessionSecret ?? config.sessionSecret;
  const fileStorage = deps.fileStorage ?? { deleteObject, ensureBucket, presignGet, presignPut };
  const providerCredentials = new ProviderCredentials(pool, config.providerCredentialSecret);
  const agentProfiles = new AgentProfiles(pool);
  const sessionRunOptions = deps.sessionRuns ?? {};
  const centaur =
    sessionRunOptions.centaur ??
    new CentaurClient({
      baseUrl: sessionRunOptions.baseUrl ?? config.centaurBaseUrl,
      apiKey: sessionRunOptions.apiKey ?? config.centaurApiKey,
    });
  const sessionRuns = new SessionRuns(pool, hub, {
    ...sessionRunOptions,
    centaur: new DemoCentaurClient(centaur),
    providerCredentials,
    agentProfiles,
  });
  const appRegistry = new AppRegistry(pool, {
    appsOrigin: config.appsOrigin,
    signingSecret: config.appSigningSecret,
    launchTtlSeconds: config.appsLaunchTtlSeconds,
    storage: { getObjectBytes },
  });

  return {
    agentProfiles,
    appRegistry,
    artifactCaptureApiKey: deps.artifactCaptureApiKey ?? config.artifactCaptureApiKey,
    calls: deps.calls === false ? null : (deps.calls ?? createLiveKitTokenService(config)),
    emailFetch: deps.emailFetch,
    fileStorage,
    hub,
    providerCredentials,
    secret,
    sessionRuns,
    voip: deps.voip ?? getVoipSender(config),
  };
}
