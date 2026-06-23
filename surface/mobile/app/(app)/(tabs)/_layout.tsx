// Bottom tab navigator (expo-router/ui headless Tabs) with a custom Liquid-Glass
// bar. Chat · Agents · Activity · Search — Search bottom-right for thumb reach.
// Real tabs: per-tab state preservation, no Stack back-arrow. Each tab screen
// renders its own header (TabSlot has none); "You/More" is the header avatar.
import { useMemo } from 'react';
import { Tabs, TabList, TabSlot, TabTrigger } from 'expo-router/ui';
import { isTerminalSessionStatus } from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { GlassBar, GlassTabButton } from '../../../src/components/GlassTabBar';

export default function TabsLayout() {
  const { state } = useChat();
  const attention = useMemo(
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
          <TabTrigger name="sessions" href="/sessions" asChild>
            <GlassTabButton icon="sparkles" label="Agents" pulse={attention > 0} />
          </TabTrigger>
          <TabTrigger name="activity" href="/activity" asChild>
            <GlassTabButton icon="notifications" label="Activity" badge={attention} />
          </TabTrigger>
          <TabTrigger name="search" href="/search" asChild>
            <GlassTabButton icon="search" label="Search" />
          </TabTrigger>
        </GlassBar>
      </TabList>
    </Tabs>
  );
}
