// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatExactTimestamp, formatTurnTime } from '@atrium/surface-client';
import { SteerRow } from '../src/components/work/SteerRow';
import type { ResolvedEntry } from '../src/lib/entryResolve';
import { pressWhenReady, renderWithTheme } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => {}),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(async () => {}),
}));

vi.mock('react-native-syntax-highlighter', () => ({
  default: ({ children }: { children: string }) => <Text>{children}</Text>,
}));

vi.mock('react-native-markdown-display', () => {
  const MarkdownDisplay = ({
    children,
    rules,
  }: {
    children: string;
    rules: Record<string, (node: { key: string; attributes: { href: string } }, children: unknown[]) => unknown>;
  }) => {
    const match = /\/e\/([^\s<>().,;:!?]+)/.exec(children);
    if (!match) return <Text>{children}</Text>;
    const renderLink = rules.link;
    if (!renderLink) return <Text>{children}</Text>;

    const before = children.slice(0, match.index);
    const after = children.slice(match.index + match[0].length);
    return (
      <>
        {before ? <Text>{before}</Text> : null}
        {renderLink({ key: 'entry-1', attributes: { href: `atrium-entry:${match[1] ?? ''}` } }, [])}
        {after ? <Text>{after}</Text> : null}
      </>
    );
  };
  const MarkdownIt = () => {
    const md = { use: () => md };
    return md;
  };
  return {
    default: MarkdownDisplay,
    MarkdownIt,
    renderRules: {},
  };
});

afterEach(cleanup);

const referencedEntry: ResolvedEntry = {
  handle: 'evt_12',
  kind: 'message',
  actor: 'Riley',
  actorLabel: 'Riley',
  text: 'Referenced entry excerpt',
  meta: {},
  targetType: 'event',
  sourceRefs: [],
  tombstoned: false,
  location: {
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    channelName: 'general',
    threadRootEventId: null,
    sessionId: null,
    sessionTitle: null,
  },
};

describe('SteerRow (mobile)', () => {
  it('shows the steer text with a muted turn timestamp', () => {
    const ts = '2026-07-02T10:15:00.000Z';
    renderWithTheme(<SteerRow text="fix the parser" ts={ts} />);
    expect(screen.getByText('fix the parser')).toBeTruthy();
    expect(screen.getByTestId('steer-time').textContent).toBe(formatTurnTime(ts));
    expect(screen.getByLabelText(`${formatTurnTime(ts)}. Exact time: ${formatExactTimestamp(ts)}`)).toBeTruthy();
  });

  it('toggles the exact turn timestamp on tap', () => {
    const ts = '2026-07-02T10:15:00.000Z';
    renderWithTheme(<SteerRow text="fix the parser" ts={ts} />);
    const time = screen.getByTestId('steer-time');

    fireEvent.click(time);
    expect(time.textContent).toBe(formatExactTimestamp(ts));

    fireEvent.click(time);
    expect(time.textContent).toBe(formatTurnTime(ts));
  });

  it('renders text only for unstamped history', () => {
    renderWithTheme(<SteerRow text="old turn" />);
    expect(screen.getByText('old turn')).toBeTruthy();
    expect(screen.queryByTestId('steer-time')).toBeNull();
  });

  it('wires tap actions when provided and exposes the actions label', () => {
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    renderWithTheme(
      <SteerRow text="fix the parser" onPress={onPress} onLongPress={onLongPress} delayLongPress={250} />,
    );

    const row = screen.getByRole('button', { name: 'Message actions: fix the parser' });
    fireEvent.click(row);

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('shows an always-visible provenance byline for accepted suggestions', () => {
    renderWithTheme(
      <SteerRow
        text="try a smaller patch"
        provenance={{
          provenance: {
            proposerName: 'Allan',
            resolvedByName: 'Jules',
            edited: false,
            resolvedAt: '2026-07-02T10:15:00.000Z',
          },
          acceptedByMe: true,
        }}
      />,
    );

    const label = 'Proposed by Allan · sent by you';
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it('marks edited accepted suggestions in the provenance byline', () => {
    renderWithTheme(
      <SteerRow
        text="try a focused patch"
        provenance={{
          provenance: {
            proposerName: 'Allan',
            resolvedByName: 'Dana',
            edited: true,
            resolvedAt: '2026-07-02T10:15:00.000Z',
          },
          acceptedByMe: false,
        }}
      />,
    );

    expect(screen.getByText('Proposed by Allan · sent by Dana · edited')).toBeTruthy();
  });

  it('renders entry links as inline chips in plain steer text', async () => {
    const resolveEntry = vi.fn<(handle: string) => Promise<ResolvedEntry | null>>().mockResolvedValue(referencedEntry);
    const onOpenChannel = vi.fn();

    renderWithTheme(
      <SteerRow
        text="Check /e/evt_12"
        serverUrl="https://atrium.example.test"
        resolveEntry={resolveEntry}
        onOpenChannel={onOpenChannel}
      />,
    );

    expect(await screen.findByText('Riley: "Referenced entry excerpt"')).toBeTruthy();
    expect(resolveEntry).toHaveBeenCalledWith('evt_12');

    // RNW attaches Pressable DOM listeners in a passive effect AFTER the commit
    // that makes the chip findable, so clicking straight after a findBy* can land
    // before the handler is wired (flaked on CI: onOpenChannel 0 calls).
    await pressWhenReady(screen.findByLabelText('Open Riley: "Referenced entry excerpt"'));
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('ch-1'));
  });
});
