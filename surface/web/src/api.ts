// Configured API instance for the web client. In the browser: same-origin paths
// + the httpOnly session cookie (no bearer token). In the Electron desktop
// shell: an absolute server origin + a bearer token (the mobile model).

import { createApi } from '@atrium/surface-client';
import { desktopApiOptions } from './desktop';

export { ApiError } from '@atrium/surface-client';
export type {
  AuthMethods,
  Workspace,
  Channel,
  AgentProfile,
  AgentProfileProposal,
  AgentProfileProvider,
  AgentProfileVersion,
  ConnectionProvider,
  ConnectionStatus,
  ProviderCredentialProvider,
  ProviderCredentialStatus,
} from '@atrium/surface-client';

export const api = createApi(desktopApiOptions());
