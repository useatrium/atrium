// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Text, View } from 'react-native';
import { Composer } from '../src/components/Composer';
import { AgentModeConfig } from '../src/components/AgentModeConfig';
import { MessageRow } from '../src/components/MessageRow';
import { enqueueSessionSuggestion } from '../src/lib/sessionSuggestion';
import { renderWithTheme } from './rnTestUtils';

vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-document-picker', () => ({}));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('expo-image', () => ({ Image: () => <View /> }));
vi.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: vi.fn(),
  setAudioModeAsync: vi.fn(),
  useAudioRecorder: () => ({}),
  useAudioRecorderState: () => ({ isRecording: false, metering: null, durationMillis: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: vi.fn(async () => {}) }));
vi.mock('../src/components/Markdown', () => ({
  EntryReferenceMarkdownProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MarkdownText: ({ text }: { text: string }) => <Text>{text}</Text>,
}));
vi.mock('../src/components/VoiceMessage', () => ({ VoiceMessage: () => <Text>Voice</Text> }));

afterEach(cleanup);

describe('agent-mode composer', () => {
  it('flips on !!, swallows the sigil, and sends through the agent route', () => {
    const onAgentSend = vi.fn();
    renderWithTheme(
      <Composer
        placeholder="Message"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        onAgentSend={onAgentSend}
        agentTargetLabel="New agent · #engineering"
        chatTargetLabel="#engineering"
      />,
    );
    expect(screen.getByTestId('composer-audience-pill')).toHaveTextContent('💬 #engineering');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '!! fix the mobile app' } });
    expect(screen.getByTestId('composer-audience-pill')).toHaveTextContent('⚡ New agent · #engineering');
    expect(screen.getByTestId('agent-mode-strip')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(onAgentSend).toHaveBeenCalledWith('fix the mobile app', undefined);
  });

  it('taps the pill to flip audience, and keeps the draft marked for the agent on the way out', () => {
    const onDraftChange = vi.fn();
    renderWithTheme(
      <Composer
        placeholder="Message"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        onAgentSend={vi.fn()}
        draftKey="channel:c1"
        onDraftChange={onDraftChange}
        agentTargetLabel="New agent · #engineering"
        chatTargetLabel="#engineering"
      />,
    );
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '!! fix the build' } });

    fireEvent.click(screen.getByTestId('composer-audience-pill'));

    expect(screen.getByTestId('composer-audience-pill')).toHaveTextContent('💬 #engineering');
    expect(screen.getByTestId('composer-agent-intent-strip')).toHaveTextContent('Agent mode off — draft kept');
    expect(onDraftChange).toHaveBeenLastCalledWith('channel:c1', 'fix the build', true);
  });

  it('restores an agent-intent draft wearing its strip rather than as a chat draft', () => {
    renderWithTheme(
      <Composer
        placeholder="Message"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        onAgentSend={vi.fn()}
        draftKey="channel:c1"
        initialDraft="fix the build"
        initialDraftAgentIntent
        agentTargetLabel="New agent · #engineering"
        chatTargetLabel="#engineering"
      />,
    );

    expect(screen.getByTestId('composer-agent-intent-strip')).toBeInTheDocument();
    expect(screen.getByTestId('composer-audience-pill')).toHaveTextContent('💬 #engineering');

    fireEvent.click(screen.getByLabelText('Resume agent mode'));
    expect(screen.getByTestId('composer-audience-pill')).toHaveTextContent('⚡ New agent · #engineering');
  });

  it('uses Suggest wording for a non-driver attached session', () => {
    renderWithTheme(
      <AgentModeConfig
        sessionTitle="Release fixes"
        isDriver={false}
        target="steer"
        effort="medium"
        onTarget={() => {}}
        onEffort={() => {}}
        onClearAnchor={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Suggest · “Release fixes”' })).toBeInTheDocument();
  });

  it('queues a non-driver suggestion with thread provenance', async () => {
    const enqueueOp = vi.fn().mockResolvedValue(undefined);

    await enqueueSessionSuggestion(enqueueOp, 'session-1', 'Please reconsider the migration');

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.suggest',
        payload: { sessionId: 'session-1', text: 'Please reconsider the migration', postToThread: true },
      }),
    );
  });

  it('renders session replies as an AI-authored markdown row and folds ticker activity into the session card', () => {
    const base = {
      id: 4,
      clientMsgId: null,
      channelId: 'c',
      threadRootEventId: 1,
      text: '**Done**',
      edited: false,
      author: { id: 'agent:s', handle: 'agent', displayName: 'Agent' },
      createdAt: '2026-07-12T12:00:00.000Z',
      replyCount: 0,
      lastReplyId: 0,
      status: 'confirmed' as const,
      sessionId: 's',
      sessionEventType: 'replied' as const,
    };
    const { rerender } = renderWithTheme(
      <MessageRow
        message={base}
        grouped={false}
        meId="u"
        meHandle={null}
        fileUrl={() => ''}
        api={{} as never}
        serverUrl=""
        resolveEntry={vi.fn()}
        onLongPress={vi.fn()}
        onToggleReaction={vi.fn()}
        onRetry={vi.fn()}
        onOpenAttachment={vi.fn()}
        session={{ id: 's', title: 'Release fixes' } as never}
      />,
    );
    expect(screen.getByTestId('agent-reply-row')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.queryByText('Release fixes')).not.toBeInTheDocument();
    expect(screen.getAllByText('hardware-chip-outline')).toHaveLength(2);
    rerender(<View />);
  });
});
