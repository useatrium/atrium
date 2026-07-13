import { Platform, ScrollView, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { parseCriticMarkup, type CriticBlock, type CriticSegment } from '@atrium/surface-client';
import { font, radius, space, useTheme, type Colors } from '../lib/theme';

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const authorPrefixPattern = /^(@[A-Za-z0-9_-]+): ([\s\S]*)$/;

function parseAuthorPrefix(text: string): { handle: string; body: string } | null {
  const match = authorPrefixPattern.exec(text);
  if (!match) return null;
  const handle = match[1];
  const body = match[2];
  if (handle == null || body == null) return null;
  return { handle, body };
}

function AuthorChipText({ handle }: { handle: string }) {
  const { colors } = useTheme();
  return (
    <Text
      style={{
        color: colors.textMuted,
        backgroundColor: colors.accentBg,
        borderRadius: radius.sm,
        fontSize: font.xs,
        fontWeight: '800',
      }}
    >
      {handle}
    </Text>
  );
}

function changeColors(colors: Colors) {
  return {
    delText: colors.danger,
    delBg: colors.dangerSurface,
    insText: colors.online,
    insBg: colors.accentBg,
    highlightBg: colors.warningSurface,
    highlightText: colors.text,
  };
}

export function countCriticMarkupChanges(blocks: CriticBlock[]): number {
  return blocks.reduce((total, block) => {
    if (block.type === 'prose') {
      return total + block.segments.filter((segment) => segment.kind !== 'text').length;
    }
    if (block.type === 'commented-code') return total + 1;
    return total;
  }, 0);
}

export function NoteRow({ label = 'Note', text, warning }: { label?: string; text: string; warning?: boolean }) {
  const { colors } = useTheme();
  const authorPrefix = parseAuthorPrefix(text);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: warning ? colors.warningBorder : colors.borderSoft,
        borderRadius: radius.sm,
        backgroundColor: warning ? colors.warningSurface : colors.bgInput,
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        gap: space.xxs,
      }}
    >
      <Text style={{ color: warning ? colors.warning : colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
        {label}
      </Text>
      {authorPrefix ? (
        <Text style={{ color: colors.textSecondary, fontSize: font.xs, lineHeight: 16 }}>
          <AuthorChipText handle={authorPrefix.handle} />
          <Text> {authorPrefix.body}</Text>
        </Text>
      ) : (
        <Text style={{ color: colors.textSecondary, fontSize: font.xs, lineHeight: 16 }}>{text}</Text>
      )}
    </View>
  );
}

function InlineCriticSegment({ segment }: { segment: Exclude<CriticSegment, { kind: 'comment' }> }) {
  const { colors } = useTheme();
  const change = changeColors(colors);
  const highlightCommentAuthor = segment.kind === 'highlight' ? parseAuthorPrefix(segment.comment) : null;

  switch (segment.kind) {
    case 'text':
      return <Text>{segment.text}</Text>;
    case 'del':
      return (
        <Text style={{ color: change.delText, backgroundColor: change.delBg, textDecorationLine: 'line-through' }}>
          {segment.text}
        </Text>
      );
    case 'ins':
      return (
        <Text style={{ color: change.insText, backgroundColor: change.insBg, textDecorationLine: 'underline' }}>
          {segment.text}
        </Text>
      );
    case 'sub':
      return (
        <Text>
          <Text style={{ color: change.delText, backgroundColor: change.delBg, textDecorationLine: 'line-through' }}>
            {segment.del}
          </Text>
          <Text style={{ color: change.insText, backgroundColor: change.insBg, textDecorationLine: 'underline' }}>
            {segment.ins}
          </Text>
        </Text>
      );
    case 'highlight':
      return (
        <Text>
          <Text style={{ color: change.highlightText, backgroundColor: change.highlightBg }}>{segment.text}</Text>
          {highlightCommentAuthor ? (
            <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
              {' Note: '}
              <AuthorChipText handle={highlightCommentAuthor.handle} />
              <Text> {highlightCommentAuthor.body}</Text>
            </Text>
          ) : (
            <Text style={{ color: colors.textMuted, fontSize: font.xs }}> Note: {segment.comment}</Text>
          )}
        </Text>
      );
  }
}

function ProseBlock({ segments }: { segments: CriticSegment[] }) {
  const { colors } = useTheme();
  const rows: ReactNode[] = [];
  let inline: Exclude<CriticSegment, { kind: 'comment' }>[] = [];
  let inlineIndex = 0;

  const flushInline = () => {
    if (inline.length === 0) return;
    const run = inline;
    rows.push(
      <Text key={`prose-${inlineIndex}`} style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>
        {run.map((segment, index) => (
          <InlineCriticSegment key={`seg-${index}`} segment={segment} />
        ))}
      </Text>,
    );
    inline = [];
    inlineIndex += 1;
  };

  for (const segment of segments) {
    if (segment.kind === 'comment') {
      flushInline();
      rows.push(<NoteRow key={`comment-${inlineIndex}-${rows.length}`} text={segment.comment} />);
      continue;
    }
    inline.push(segment);
  }
  flushInline();

  return <View style={{ gap: space.xs }}>{rows}</View>;
}

function CodeBlock({ block }: { block: Extract<CriticBlock, { type: 'code' | 'commented-code' }> }) {
  const { colors } = useTheme();
  const fenceLabel = block.fence.replace(/^`+/, '').trim();
  return (
    <View style={{ gap: space.xs }}>
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.borderSoft,
          borderRadius: radius.sm,
          backgroundColor: colors.bgInput,
          overflow: 'hidden',
        }}
      >
        {fenceLabel ? (
          <Text
            style={{
              color: colors.textMuted,
              fontFamily: monoFont,
              fontSize: font.xs,
              paddingHorizontal: space.sm,
              paddingTop: space.xs,
            }}
          >
            {fenceLabel}
          </Text>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            style={{
              color: colors.textSecondary,
              fontFamily: monoFont,
              fontSize: font.sm,
              lineHeight: 19,
              paddingHorizontal: space.sm,
              paddingVertical: space.xs,
            }}
          >
            {block.content}
          </Text>
        </ScrollView>
      </View>
      {block.type === 'commented-code' ? <NoteRow text={block.comment} /> : null}
    </View>
  );
}

function SeparatorRow() {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityLabel="Skipped content"
      style={{ color: colors.textMuted, fontSize: font.md, lineHeight: 20, textAlign: 'center' }}
    >
      ⋯
    </Text>
  );
}

export function CriticMarkupBlocks({ blocks }: { blocks: CriticBlock[] }) {
  return (
    <View style={{ gap: space.sm }}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'prose':
            return <ProseBlock key={`block-${index}`} segments={block.segments} />;
          case 'code':
          case 'commented-code':
            return <CodeBlock key={`block-${index}`} block={block} />;
          case 'separator':
            return <SeparatorRow key={`block-${index}`} />;
        }
        return null;
      })}
    </View>
  );
}

export function CriticMarkupText({ text }: { text: string }) {
  return <CriticMarkupBlocks blocks={parseCriticMarkup(text)} />;
}
