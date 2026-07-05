// Web-side (webview) glue that lets MarkupVersionHistory run against the native app instead
// of fetch: it posts `markup-vh-request` messages over the RN bridge and resolves them when
// the matching `markup-vh-response` comes back. Native performs the authed /api/files calls,
// so the auth token never enters the webview.

import {
  type MarkupShellInbound,
  type MarkupVersionOp,
  type ReactNativeWebViewBridge,
  postMarkupShellMessage,
} from '../MarkupShellBridge';
import type { VersionTransport } from '../components/MarkupVersionHistory';

type VhResponse = Extract<MarkupShellInbound, { type: 'markup-vh-response' }>;

export interface BridgeVersionTransport {
  transport: VersionTransport;
  /** Feed an incoming markup-vh-response so the awaiting request can settle. */
  handleResponse(response: VhResponse): void;
}

export function createBridgeVersionTransport(bridge: ReactNativeWebViewBridge | undefined): BridgeVersionTransport {
  const pending = new Map<string, (response: VhResponse) => void>();
  let counter = 0;

  function request(op: MarkupVersionOp, seq?: number): Promise<VhResponse> {
    counter += 1;
    const reqId = `vh-${counter}-${op}`;
    return new Promise<VhResponse>((resolve) => {
      pending.set(reqId, resolve);
      postMarkupShellMessage(bridge, { type: 'markup-vh-request', reqId, op, ...(seq != null ? { seq } : {}) });
    });
  }

  async function expectOk(op: MarkupVersionOp, seq?: number): Promise<VhResponse> {
    const response = await request(op, seq);
    if (!response.ok) throw new Error(response.error || `version history ${op} failed`);
    return response;
  }

  return {
    handleResponse(response) {
      const resolve = pending.get(response.reqId);
      if (!resolve) return;
      pending.delete(response.reqId);
      resolve(response);
    },
    transport: {
      async listVersions() {
        return (await expectOk('list')).versions ?? [];
      },
      async fetchVersionContent(seq) {
        const response = await expectOk('content', seq);
        return new Blob([response.content ?? ''], { type: 'text/markdown' });
      },
      async revertVersion(seq) {
        const response = await expectOk('revert', seq);
        return response.seq ?? seq;
      },
      async restoreFile() {
        return (await expectOk('restore')).seq;
      },
    },
  };
}
