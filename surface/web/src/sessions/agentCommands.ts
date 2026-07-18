import type { QuickSwitcherCommand } from '../components/QuickSwitcher';
import { isLiveAgentWork, isPendingSessionId, type Session } from './types';

export function buildAgentCommands(
  sessions: Record<string, Session>,
  onFocusAgent: (id: string) => void,
): QuickSwitcherCommand[] {
  return Object.values(sessions)
    .filter((session) => !isPendingSessionId(session.id) && isLiveAgentWork(session))
    .map((session) => ({
      id: `agent:${session.id}`,
      label: session.title,
      subtitle: `#${session.channelId}`,
      group: 'Agents',
      keywords: ['agent', 'session', session.title, session.channelId, session.harness],
      run: () => onFocusAgent(session.id),
    }));
}
