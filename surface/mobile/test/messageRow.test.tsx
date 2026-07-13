// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Text, View } from 'react-native';
import type { ChatMessage } from '@atrium/surface-client';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageRow } from '../src/components/MessageRow';
import { renderWithTheme } from './rnTestUtils';

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
}));

vi.mock('expo-image', () => ({
  Image: (props: { children?: ReactNode }) => <View>{props.children}</View>,
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('../src/components/Markdown', () => ({
  EntryReferenceMarkdownProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  MarkdownText: ({ text }: { text: string }) => <Text>{text}</Text>,
}));

vi.mock('../src/components/VoiceMessage', () => ({
  VoiceMessage: () => <Text>Voice message</Text>,
}));

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 99,
    clientMsgId: null,
    channelId: 'c-1',
    threadRootEventId: null,
    text: 'thread reply',
    edited: false,
    author: { id: 'u-1', handle: 'riley', displayName: 'Riley' },
    createdAt: '2026-07-03T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

function renderRow(overrides: Partial<ChatMessage> = {}, props: Partial<ComponentProps<typeof MessageRow>> = {}) {
  const rowMessage = message(overrides);
  const onOpenThread = vi.fn();
  const rendered = renderWithTheme(
    <MessageRow
      message={rowMessage}
      grouped={false}
      meId="u-2"
      meHandle="me"
      fileUrl={(id) => `http://example.test/files/${id}`}
      api={{} as ComponentProps<typeof MessageRow>['api']}
      serverUrl="http://example.test"
      resolveEntry={vi.fn()}
      onLongPress={vi.fn()}
      onOpenThread={onOpenThread}
      onToggleReaction={vi.fn()}
      onRetry={vi.fn()}
      onOpenAttachment={vi.fn()}
      {...props}
    />,
  );
  return { rowMessage, onOpenThread, ...rendered };
}

afterEach(cleanup);

describe('MessageRow', () => {
  it('shows a parent-thread affordance for broadcast replies in the channel timeline', () => {
    const { rowMessage, onOpenThread } = renderRow({ threadRootEventId: 42, broadcast: true });

    fireEvent.click(screen.getByRole('button', { name: 'Replied to a thread' }));

    expect(screen.getByText('↳ replied to a thread')).toBeInTheDocument();
    expect(onOpenThread).toHaveBeenCalledWith(rowMessage);
  });

  it('does not show the parent-thread affordance inside thread views', () => {
    renderRow({ threadRootEventId: 42, broadcast: true }, { inThread: true });

    expect(screen.queryByText('↳ replied to a thread')).not.toBeInTheDocument();
  });

  it('adds the mention accent treatment when the message mentions me by stable id', () => {
    const meId = '123e4567-e89b-12d3-a456-426614174000';
    const { container } = renderRow({ text: `hello <@${meId}>` }, { meId });

    expect(container.querySelector('[style*="border-left-width: 3px"]')).not.toBeNull();
  });

  it('lets the driver answer a pending question from an option or typed text', async () => {
    const answerQuestion = vi.fn(async () => {});
    const questionMessage = {
      sessionId: 's-1',
      sessionEventType: 'question_requested' as const,
      sessionEventPayload: {
        questionId: 'pending-1',
        questions: [{ question: 'Should we deploy?' }],
      },
    };
    const session = {
      id: 's-1',
      driverId: 'u-2',
      pendingQuestion: {
        questionId: 'pending-1',
        questions: [
          {
            id: 'deploy',
            header: 'Deploy',
            question: 'Should we deploy?',
            options: [
              { label: 'Deploy now', description: 'Ship the current build.' },
              { label: 'Wait', description: 'Hold this release.' },
            ],
          },
        ],
      },
    };
    const first = renderRow(questionMessage, {
      session: session as never,
      onAnswerSessionQuestion: answerQuestion,
      onSuggestSessionAnswer: vi.fn(async () => {}),
    });

    expect(screen.getByRole('button', { name: 'Deploy now' })).toBeInTheDocument();
    expect(screen.getByLabelText('Type an answer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Deploy now' }));
    await waitFor(() =>
      expect(answerQuestion).toHaveBeenCalledWith('s-1', 'pending-1', {
        deploy: { answers: ['Deploy now'] },
      }),
    );

    first.unmount();
    const typedAnswer = vi.fn(async () => {});
    renderRow(questionMessage, {
      session: session as never,
      onAnswerSessionQuestion: typedAnswer,
      onSuggestSessionAnswer: vi.fn(async () => {}),
    });
    fireEvent.change(screen.getByLabelText('Type an answer'), { target: { value: 'Deploy after review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer question' }));
    await waitFor(() =>
      expect(typedAnswer).toHaveBeenCalledWith('s-1', 'pending-1', {
        deploy: { answers: ['Deploy after review'] },
      }),
    );
  });

  it('lets a non-driver suggest an answer', async () => {
    const suggestAnswer = vi.fn(async () => {});
    renderRow(
      {
        sessionId: 's-1',
        sessionEventType: 'question_requested',
        sessionEventPayload: {
          questionId: 'pending-1',
          questions: [{ question: 'Should we deploy?' }],
        },
      },
      {
        session: {
          id: 's-1',
          driverId: 'u-driver',
          pendingQuestion: {
            questionId: 'pending-1',
            questions: [{ id: 'deploy', header: 'Deploy', question: 'Should we deploy?' }],
          },
        } as never,
        onAnswerSessionQuestion: vi.fn(async () => {}),
        onSuggestSessionAnswer: suggestAnswer,
      },
    );

    expect(screen.getByRole('button', { name: 'Suggest an answer' })).toBeInTheDocument();
    expect(screen.getByText('The current driver decides what to send.')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Suggest an answer…'), {
      target: { value: 'Wait for the smoke test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest an answer' }));
    await waitFor(() => expect(suggestAnswer).toHaveBeenCalledWith('s-1', 'Wait for the smoke test'));
  });

  it('replaces the answer form with who answered, once the question resolves', () => {
    renderRow(
      {
        sessionId: 's-1',
        sessionEventType: 'question_requested',
        sessionEventPayload: {
          questionId: 'pending-1',
          questions: [{ question: 'Should we deploy?' }],
        },
      },
      {
        session: {
          id: 's-1',
          driverId: 'u-2',
          pendingQuestion: null,
          questionEvents: [
            {
              id: 12,
              questionId: 'pending-1',
              kind: 'answered',
              at: new Date().toISOString(),
              actorId: 'u-2',
              actorName: 'Maya',
              answers: [{ id: 'deploy', header: 'Deploy', answers: ['Deploy now'], count: 1 }],
            },
          ],
        } as never,
        onAnswerSessionQuestion: vi.fn(async () => {}),
        onSuggestSessionAnswer: vi.fn(async () => {}),
      },
    );

    expect(screen.queryByTestId('inline-question-answer')).not.toBeInTheDocument();
    expect(screen.getByText('Answered by')).toBeInTheDocument();
    expect(screen.getByText('Maya')).toBeInTheDocument();
    expect(screen.getByText('Deploy now')).toBeInTheDocument();
  });

  it('keeps answered question cards unchanged', () => {
    renderRow(
      {
        sessionId: 's-1',
        sessionEventType: 'question_answered',
        sessionEventPayload: {
          answers: [{ id: 'deploy', header: 'Deploy', answers: ['Deploy now'], count: 1 }],
        },
      },
      {
        session: {
          id: 's-1',
          pendingQuestion: null,
        } as never,
        onAnswerSessionQuestion: vi.fn(async () => {}),
        onSuggestSessionAnswer: vi.fn(async () => {}),
      },
    );

    expect(screen.getByText('Question answered')).toBeInTheDocument();
    expect(screen.getByText('Deploy now')).toBeInTheDocument();
    expect(screen.queryByTestId('inline-question-answer')).not.toBeInTheDocument();
  });
});
