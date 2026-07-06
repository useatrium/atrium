// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
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
  renderWithTheme(
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
  return { rowMessage, onOpenThread };
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
});
