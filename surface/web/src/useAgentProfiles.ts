import { useEffect, useState } from 'react';
import { api, type AgentProfile } from './api';

export function useAgentProfiles(): AgentProfile[] {
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);

  useEffect(() => {
    api
      .agentProfiles()
      .then(({ profiles }) => setAgentProfiles(profiles))
      .catch((err: unknown) => {
        console.warn('failed to load agent profiles', err);
      });
  }, []);

  return agentProfiles;
}
