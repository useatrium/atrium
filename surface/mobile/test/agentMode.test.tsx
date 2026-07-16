// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Alert, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Composer } from '../src/components/Composer';
import { agentDestination, peopleDestination } from '@atrium/surface-client';
import { AgentModeConfig } from '../src/components/AgentModeConfig';
import { MessageRow } from '../src/components/MessageRow';
import { enqueueSessionSuggestion } from '../src/lib/sessionSuggestion';
import { renderWithTheme } from './rnTestUtils';

const audioState = vi.hoisted(() => ({ isRecording: false, metering: null as number | null, durationMillis: 0 }));

vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('expo-image', () => ({ Image: () => <View /> }));
vi.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: vi.fn(),
  setAudioModeAsync: vi.fn(),
  useAudioRecorder: () => ({}),
  useAudioRecorderState: () => audioState,
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
  MaterialCommunityIcons: ({ name }: { name: string }) => <Text>{name}</Text>,
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: vi.fn(async () => {}) }));
vi.mock('../src/components/Markdown', () => ({
  EntryReferenceMarkdownProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MarkdownText: ({ text }: { text: string }) => <Text>{text}</Text>,
}));
vi.mock('../src/components/VoiceMessage', () => ({ VoiceMessage: () => <Text>Voice</Text> }));

afterEach(() => {
  audioState.isRecording = false;
  cleanup();
});

describe('agent-mode composer', () => {
  const destinations = {
    peopleDestination: peopleDestination('thread', 'this thread'),
    agentRouting: {
      destination: agentDestination(
        { target: 'steer' as const, sessionId: 'session-1', threadRootEventId: 1 },
        'Release fixes',
      ),
      onSubmit: vi.fn(),
    },
  };

  it('defaults an attached thread to steer and flips explicitly to an aside', () => {
    renderWithTheme(
      <Composer placeholder="Reply in thread" onSend={vi.fn()} onTyping={vi.fn()} {...destinations} initialAgentMode />,
    );
    expect(screen.getByRole('textbox', { name: 'Prompt agent' })).toHaveAttribute('placeholder', 'Prompt agent…');
    expect(screen.queryByText('Prompts Release fixes')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('composer-audience-toggle'));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Message people…');
  });

  it('flips on !!, swallows the sigil, and sends through the agent route', () => {
    const onAgentSend = vi.fn();
    renderWithTheme(
      <Composer
        placeholder="Message"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        peopleDestination={peopleDestination('channel', '#engineering')}
        agentRouting={{
          destination: agentDestination({ target: 'spawn-channel' }, 'New agent · #engineering'),
          onSubmit: onAgentSend,
        }}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Message people…');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: '!! fix the mobile app' },
    });
    expect(screen.getByRole('textbox', { name: 'Prompt agent' })).toHaveAttribute('placeholder', 'Prompt agent…');
    expect(screen.getByTestId('agent-mode-strip')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Start'));
    expect(onAgentSend).toHaveBeenCalledWith({ target: 'spawn-channel' }, { text: 'fix the mobile app' });
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Message people…');
  });

  it('keeps Steer selected after send and does not expose voice in Agent mode', () => {
    const onSubmit = vi.fn();
    renderWithTheme(
      <Composer
        placeholder="Reply"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        allowAttachments
        uploadFile={vi.fn()}
        peopleDestination={peopleDestination('thread', 'this thread')}
        agentRouting={{
          destination: agentDestination({ target: 'steer', sessionId: 's1' }, 'Release fixes'),
          onSubmit,
        }}
        initialAgentMode
      />,
    );

    expect(screen.queryByLabelText('Record voice message')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Prompt agent'), { target: { value: 'Check the failing test' } });
    fireEvent.click(screen.getByLabelText('Steer'));

    expect(onSubmit).toHaveBeenCalledWith({ target: 'steer', sessionId: 's1' }, { text: 'Check the failing test' });
    expect(screen.getByRole('textbox', { name: 'Prompt agent' })).toBeInTheDocument();
  });

  it('forwards uploaded files through the typed agent request', async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///plan.txt', name: 'plan.txt', mimeType: 'text/plain', size: 12, lastModified: 0 }],
    });
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(vi.fn());
    const onSubmit = vi.fn();
    const uploadFile = vi.fn().mockResolvedValue({
      id: 'file-1',
      filename: 'plan.txt',
      contentType: 'text/plain',
      size: 12,
      uploadKey: 'upload-1',
      localUri: 'file:///plan.txt',
    });
    renderWithTheme(
      <Composer
        placeholder="Message"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        allowAttachments
        uploadFile={uploadFile}
        peopleDestination={peopleDestination('channel', '#engineering')}
        agentRouting={{
          destination: agentDestination({ target: 'spawn-channel' }, 'New agent · #engineering'),
          onSubmit,
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('Attach file'));
    const actions = alert.mock.calls[0]?.[2];
    actions?.[2]?.onPress?.();
    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Read this' } });
    fireEvent.click(screen.getByTestId('composer-audience-toggle'));
    fireEvent.click(screen.getByLabelText('Start'));

    expect(onSubmit).toHaveBeenCalledWith(
      { target: 'spawn-channel' },
      {
        text: 'Read this',
        attachments: [{ id: 'file-1', filename: 'plan.txt', contentType: 'text/plain', size: 12 }],
        attachmentRefs: [{ uploadKey: 'upload-1' }],
      },
    );
    alert.mockRestore();
  });

  it('switches an existing draft immediately and persists its new audience', () => {
    const onDraftChange = vi.fn();
    renderWithTheme(
      <Composer
        placeholder="Message"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        peopleDestination={peopleDestination('channel', '#engineering')}
        agentRouting={{
          destination: agentDestination({ target: 'spawn-channel' }, 'New agent · #engineering'),
          onSubmit: vi.fn(),
        }}
        draftKey="channel:c1"
        onDraftChange={onDraftChange}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '!! fix the build' } });

    fireEvent.click(screen.getByTestId('composer-audience-toggle'));

    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Message people…');
    expect(onDraftChange).toHaveBeenLastCalledWith('channel:c1', 'fix the build', false);
  });

  it('restores an agent-intent draft in Agent mode', () => {
    renderWithTheme(
      <Composer
        placeholder="Message"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        peopleDestination={peopleDestination('channel', '#engineering')}
        agentRouting={{
          destination: agentDestination({ target: 'spawn-channel' }, 'New agent · #engineering'),
          onSubmit: vi.fn(),
        }}
        draftKey="channel:c1"
        initialDraft="fix the build"
        initialDraftAgentIntent
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Prompt agent' })).toHaveAttribute('placeholder', 'Prompt agent…');
    expect(screen.getByLabelText('Agent mode selected. Switch to People mode.')).toBeInTheDocument();
  });

  it('restores a saved People draft in an attached thread', () => {
    renderWithTheme(
      <Composer
        placeholder="Reply"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        {...destinations}
        initialAgentMode
        draftKey="thread:1"
        initialDraft="Keep this in the discussion"
        initialDraftAgentIntent={false}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Message people…');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this in the discussion');
  });

  it('locks the audience while a People voice recording is active', () => {
    audioState.isRecording = true;
    renderWithTheme(
      <Composer
        placeholder="Reply"
        onSend={vi.fn()}
        onTyping={vi.fn()}
        allowAttachments
        uploadFile={vi.fn()}
        {...destinations}
      />,
    );

    const audienceToggle = screen.getByTestId('composer-audience-toggle');
    expect(audienceToggle).toBeDisabled();
    fireEvent.click(audienceToggle);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Message people…');
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
    // AgentChip is gone; the row carries the AgentMark's robot glyph instead.
    expect(screen.getAllByText('robot').length).toBeGreaterThanOrEqual(1);
    rerender(<View />);
  });
});
