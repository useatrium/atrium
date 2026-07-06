import type { ReactNode } from 'react';
import { View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CallWire, Channel, UserRef } from '@atrium/surface-client';
import { useChat } from '../lib/chat';
import { labelForCallChannel } from '../lib/useCall';
import { CallNotice, InCallPanel, IncomingCallBanner, JoinCallStrip } from './CallUI';

type CallState = ReturnType<typeof useChat>['calls'];

function hasCallBanner(calls: CallState): boolean {
  return !!(calls.notice || calls.incomingCall || calls.activeCall || calls.recoverableCall);
}

function CallBannerSafeArea({
  children,
  hasBanner,
}: {
  children: ReactNode;
  hasBanner: boolean;
}) {
  return (
    <SafeAreaInsetsContext.Consumer>
      {(insets) => (
        <SafeAreaInsetsContext.Provider
          value={{
            top: hasBanner ? 0 : (insets?.top ?? 0),
            bottom: insets?.bottom ?? 0,
            left: insets?.left ?? 0,
            right: insets?.right ?? 0,
          }}
        >
          {children}
        </SafeAreaInsetsContext.Provider>
      )}
    </SafeAreaInsetsContext.Consumer>
  );
}

export function CallBannerLayout({ children }: { children: ReactNode }) {
  const { calls } = useChat();
  return (
    <View style={{ flex: 1 }}>
      <GlobalCallUI />
      <CallBannerSafeArea hasBanner={hasCallBanner(calls)}>{children}</CallBannerSafeArea>
    </View>
  );
}

function fallbackUser(id: string): UserRef {
  return { id, handle: id, displayName: id };
}

function userForCall(call: CallWire, channels: Channel[], userId: string): UserRef {
  return (
    call.participants.find((u) => u.id === userId) ??
    channels.find((c) => c.id === call.channelId)?.members?.find((u) => u.id === userId) ??
    fallbackUser(userId)
  );
}

/**
 * App-wide call surfaces — the incoming-ring banner, the in-call panel, and the
 * transient notice — rendered once at the layout root so a call shows on ANY
 * screen, not just the channel it was started from. Renders nothing when idle.
 */
export function GlobalCallUI() {
  const { state, me, calls } = useChat();
  const insets = useSafeAreaInsets();

  if (!hasCallBanner(calls)) {
    return null;
  }

  const incomingCaller = calls.incomingCall
    ? userForCall(calls.incomingCall, state.channels, calls.incomingCall.initiatorId)
    : null;
  const incomingChannelName = calls.incomingCall
    ? labelForCallChannel(calls.incomingCall, state.channels, me.id)
    : '';
  const activeChannelName = calls.activeCall
    ? labelForCallChannel(calls.activeCall.call, state.channels, me.id)
    : '';
  const recoverableChannelName = calls.recoverableCall
    ? labelForCallChannel(calls.recoverableCall, state.channels, me.id)
    : '';

  return (
    <View style={{ paddingTop: insets.top }}>
      {calls.notice && <CallNotice message={calls.notice} onDismiss={calls.clearNotice} />}
      {calls.incomingCall && incomingCaller ? (
        <IncomingCallBanner
          call={calls.incomingCall}
          caller={incomingCaller}
          channelName={incomingChannelName}
          answering={calls.answering}
          onAccept={() => void calls.acceptIncomingCall()}
          onDecline={() => void calls.declineIncomingCall()}
        />
      ) : null}
      {!calls.activeCall && calls.recoverableCall ? (
        <JoinCallStrip
          call={calls.recoverableCall}
          meId={me.id}
          channelName={recoverableChannelName}
          joining={calls.answering}
          onJoin={() => void calls.joinRecoverableCall(calls.recoverableCall?.id)}
        />
      ) : null}
      {calls.activeCall ? (
        <InCallPanel
          call={calls.activeCall}
          meId={me.id}
          channelName={activeChannelName}
          onToggleMute={() => void calls.toggleMute()}
          onLeave={() => void calls.leaveActiveCall()}
        />
      ) : null}
    </View>
  );
}
