// Bottom tab navigator (expo-router/ui headless Tabs) with a custom Liquid-Glass
// bar. Chat · Files · Agents · Inbox · Search. Search is bottom-right for thumb reach.
// Real tabs: per-tab state preservation, no Stack back-arrow. Each tab screen
// renders its own header (TabSlot has none); settings is the header avatar.
import { useMemo } from 'react';
import { Tabs, TabList, TabSlot, TabTrigger } from 'expo-router/ui';
import { isTerminalSessionStatus } from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { GlassBar, GlassTabButton } from '../../../src/components/GlassTabBar';

export default function TabsLayout() {
  const { state } = useChat();
  const activeAgents = useMemo(
    () =>
      Object.values(state.sessions ?? {}).filter(
        (s) => s && s.status && !isTerminalSessionStatus(s.status),
      ).length,
    [state.sessions],
  );

  return (
    <Tabs>
      <TabSlot />
      <TabList asChild>
        <GlassBar>
          <TabTrigger name="index" href="/" asChild>
            <GlassTabButton icon="chatbubbles" label="Chat" />
          </TabTrigger>
          <TabTrigger name="files" href="/files" asChild>
            <GlassTabButton icon="folder-open" label="Files" />
          </TabTrigger>
          <TabTrigger name="sessions" href="/sessions" asChild>
            <GlassTabButton icon="terminal" label="Agents" pulse={activeAgents > 0} />
          </TabTrigger>
          <TabTrigger name="activity" href="/activity" asChild>
            <GlassTabButton icon="notifications" label="Inbox" badge={activeAgents} />
          </TabTrigger>
          <TabTrigger name="search" href="/search" asChild>
            <GlassTabButton icon="search" label="Search" />
          </TabTrigger>
        </GlassBar>
      </TabList>
    </Tabs>
  );
}
