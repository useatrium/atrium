import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  api,
  type ConnectionProvider,
  type ConnectionStatus,
} from './api';

export type ConnectionMap = Record<string, ConnectionStatus | undefined>;

export function useConnections() {
  const [connections, setConnections] = useState<ConnectionMap>({});
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [connectionDialog, setConnectionDialog] = useState<ConnectionProvider | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      setLoading(true);
      const { connections } = await api.connections();
      setConnections(Object.fromEntries(connections.map((connection) => [connection.provider, connection])));
      setAvailable(true);
    } catch (err) {
      if (isMissingConnectionsEndpoint(err)) {
        setConnections({});
        setAvailable(false);
      } else {
        console.warn('failed to load connections', err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const connectGitHub = useCallback(async (body: Record<string, unknown> = {}) => {
    try {
      const { connection, authorizeUrl } = await api.connectGitHub(body);
      setAvailable(true);
      setConnections((prev) => ({ ...prev, [connection.provider]: connection }));
      if (authorizeUrl) {
        window.location.assign(authorizeUrl);
        return;
      }
      await loadConnections();
    } catch (err) {
      if (isMissingConnectionsEndpoint(err)) {
        setAvailable(false);
        setConnections({});
        return;
      }
      throw err;
    }
  }, [loadConnections]);

  const disconnectGitHub = useCallback(async () => {
    try {
      const { connection } = await api.disconnectGitHub();
      setConnections((prev) => ({
        ...prev,
        github: connection,
      }));
    } catch (err) {
      if (isMissingConnectionsEndpoint(err)) {
        setAvailable(false);
        setConnections({});
        return;
      }
      throw err;
    }
  }, []);

  const activateGitHubIdentity = useCallback(async (identityId: string) => {
    try {
      const workspaceId = connections.github?.workspaceId;
      const { connection } = await api.activateGitHubIdentity({
        identityId,
        ...(workspaceId ? { workspaceId } : {}),
      });
      setConnections((prev) => ({ ...prev, github: connection }));
    } catch (err) {
      if (isMissingConnectionsEndpoint(err)) {
        setAvailable(false);
        setConnections({});
        return;
      }
      throw err;
    }
  }, [connections.github?.workspaceId]);

  return useMemo(
    () => ({
      activateGitHubIdentity,
      available,
      connectGitHub,
      connectionDialog,
      connections,
      disconnectGitHub,
      githubConnection: connections.github,
      loading,
      setConnectionDialog,
    }),
    [
      activateGitHubIdentity,
      available,
      connectGitHub,
      connectionDialog,
      connections,
      disconnectGitHub,
      loading,
      setConnectionDialog,
    ],
  );
}

function isMissingConnectionsEndpoint(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}
