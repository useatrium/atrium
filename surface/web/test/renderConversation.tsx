import type { ThreadPanelProps } from '../src/components/ThreadPanel';
import { ConversationPanel } from '../src/sessions/ConversationPanel';
import type { SessionPaneProps } from '../src/sessions/SessionPane';

export function ThreadPanelHarness(props: ThreadPanelProps) {
  return <ConversationPanel mode="thread" thread={props} />;
}

export function SessionPaneHarness({ visible = true, ...session }: SessionPaneProps & { visible?: boolean }) {
  return <ConversationPanel mode={visible ? 'work' : 'thread'} session={session} />;
}
