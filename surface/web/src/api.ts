// Configured API instance for the web client: same-origin paths + the
// httpOnly session cookie (no bearer token needed in the browser).

import { createApi } from '@atrium/surface-client';

export { ApiError } from '@atrium/surface-client';
export type { Workspace, Channel, ProviderCredentialStatus } from '@atrium/surface-client';

export const api = createApi();
