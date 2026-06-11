import * as Clipboard from 'expo-clipboard';
import { tokenizeMessage, type Segment } from '@atrium/surface-client';
import type { ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { font, radius, space, useTheme } from '../lib/theme';
import { selectionHaptic } from '../lib/haptics';

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function InlineSegment({
  segment,
  meHandle,
  muted,
}: {
  segment: Exclude<Segment, { kind: 'codeblock' }>;
  meHandle: string | null;
  muted?: boolean;
}) {
  const { colors } = useTheme();
  switch (segment.kind) {
    case 'text':
      return <Text>{segment.text}</Text>;
    case 'code':
      return (
        <Text
          style={{
            backgroundColor: colors.bgElevated,
            borderRadius: radius.sm,
            color: muted ? colors.textMuted : colors.codeAccent,
            fontFamily: monoFont,
            fontSize: font.sm,
            paddingHorizontal: 4,
            paddingVertical: 1,
          }}
        >
          {segment.code}
        </Text>
      );
    case 'link':
      return (
        <Text
          style={{ color: colors.accent, textDecorationLine: 'underline' }}
          onPress={() => Linking.openURL(segment.href).catch(() => {})}
          suppressHighlighting
        >
          {segment.href}
        </Text>
      );
    case 'mention': {
      const isMe = meHandle != null && segment.handle.toLowerCase() === meHandle.toLowerCase();
      return (
        <Text
          style={{
            color: colors.accent,
            fontWeight: '600',
            ...(isMe ? { backgroundColor: colors.accentBg } : {}),
          }}
        >
          @{segment.handle}
        </Text>
      );
    }
  }
}

function InlineRun({
  segments,
  meHandle,
  muted,
}: {
  segments: Exclude<Segment, { kind: 'codeblock' }>[];
  meHandle: string | null;
  muted?: boolean;
}) {
  const { colors } = useTheme();
  if (segments.length === 0) return null;
  return (
    <Text
      style={{
        color: muted ? colors.textMuted : colors.text,
        fontSize: font.md,
        lineHeight: 21,
      }}
    >
      {segments.map((segment, i) => (
        <InlineSegment key={`i${i}`} segment={segment} meHandle={meHandle} muted={muted} />
      ))}
    </Text>
  );
}

function CodeBlock({
  segment,
  muted,
}: {
  segment: Extract<Segment, { kind: 'codeblock' }>;
  muted?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onLongPress={() => {
        selectionHaptic();
        void Clipboard.setStringAsync(segment.code).catch(() => {});
      }}
      style={{
        alignSelf: 'stretch',
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderRadius: radius.md,
        borderWidth: 1,
        marginVertical: 4,
        overflow: 'hidden',
      }}
    >
      {segment.lang ? (
        <Text
          style={{
            color: colors.textMuted,
            fontFamily: monoFont,
            fontSize: font.xs,
            paddingRight: space.sm,
            paddingTop: space.xs,
            position: 'absolute',
            right: 0,
            top: 0,
            zIndex: 1,
          }}
        >
          {segment.lang}
        </Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text
          style={{
            color: muted ? colors.textMuted : colors.textSecondary,
            fontFamily: monoFont,
            fontSize: font.sm,
            lineHeight: 19,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            paddingRight: segment.lang ? space.xl * 2 : space.md,
          }}
        >
          {segment.code}
        </Text>
      </ScrollView>
    </Pressable>
  );
}

/** Message text with shared web/mobile formatting semantics. */
export function MessageText({
  text,
  meHandle,
  muted,
}: {
  text: string;
  meHandle: string | null;
  muted?: boolean;
}) {
  const rendered: ReactNode[] = [];
  let inline: Exclude<Segment, { kind: 'codeblock' }>[] = [];
  let inlineRun = 0;

  for (const segment of tokenizeMessage(text)) {
    if (segment.kind !== 'codeblock') {
      inline.push(segment);
      continue;
    }
    rendered.push(
      <InlineRun key={`t${inlineRun}`} segments={inline} meHandle={meHandle} muted={muted} />,
    );
    inline = [];
    rendered.push(<CodeBlock key={`c${inlineRun}`} segment={segment} muted={muted} />);
    inlineRun++;
  }
  rendered.push(
    <InlineRun key={`t${inlineRun}`} segments={inline} meHandle={meHandle} muted={muted} />,
  );

  return <View style={{ alignSelf: 'stretch', gap: 2 }}>{rendered}</View>;
}
