import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ProviderCredentialProvider,
  type ProviderCredentialStatus,
} from './api';

export function useProviderCredentials() {
  const [providerCredentials, setProviderCredentials] = useState<
    Record<string, ProviderCredentialStatus | undefined>
  >({});
  const [providerDialog, setProviderDialog] = useState<ProviderCredentialProvider | null>(null);

  const loadProviderCredentials = useCallback(async () => {
    try {
      const { providers } = await api.providerCredentials();
      setProviderCredentials(Object.fromEntries(providers.map((p) => [p.provider, p])));
    } catch (err) {
      console.warn('failed to load provider credentials', err);
    }
  }, []);

  useEffect(() => {
    void loadProviderCredentials();
  }, [loadProviderCredentials]);

  const saveClaudeToken = useCallback(
    async (token: string) => {
      const { provider } = await api.connectClaudeCode(token);
      setProviderCredentials((prev) => ({ ...prev, [provider.provider]: provider }));
      await loadProviderCredentials();
    },
    [loadProviderCredentials],
  );

  const saveCodexAuthJson = useCallback(
    async (authJson: string) => {
      const { provider } = await api.connectCodex(authJson);
      setProviderCredentials((prev) => ({ ...prev, [provider.provider]: provider }));
      await loadProviderCredentials();
    },
    [loadProviderCredentials],
  );

  const disconnectClaude = useCallback(async () => {
    await api.disconnectClaudeCode();
    setProviderCredentials((prev) => ({
      ...prev,
      'claude-code': disconnectedProviderStatus('claude-code'),
    }));
  }, []);

  const disconnectCodex = useCallback(async () => {
    await api.disconnectCodex();
    setProviderCredentials((prev) => ({
      ...prev,
      codex: disconnectedProviderStatus('codex'),
    }));
  }, []);

  const openProviderConnect = useCallback(() => {
    setProviderDialog(providerCredentials.codex?.connected ? 'claude-code' : 'codex');
  }, [providerCredentials.codex?.connected]);

  return {
    disconnectClaude,
    disconnectCodex,
    openProviderConnect,
    providerCredentials,
    providerDialog,
    saveClaudeToken,
    saveCodexAuthJson,
    setProviderDialog,
  };
}

function disconnectedProviderStatus(
  provider: ProviderCredentialProvider,
): ProviderCredentialStatus {
  return {
    provider,
    connected: false,
    status: 'needs_auth',
    lastValidatedAt: null,
    lastError: null,
    updatedAt: null,
  };
}
