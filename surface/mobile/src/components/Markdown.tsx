import { Ionicons } from '@expo/vector-icons';
import { compactMarkdownSource, type UserRef } from '@atrium/surface-client';
import * as Clipboard from 'expo-clipboard';
import {
  Component,
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import MarkdownDisplay, {
  MarkdownIt,
  renderRules,
  type ASTNode,
  type RenderRules,
} from 'react-native-markdown-display';
// @ts-expect-error react-native-syntax-highlighter does not publish TypeScript declarations.
import SyntaxHighlighter from 'react-native-syntax-highlighter';
import { selectionHaptic } from '../lib/haptics';
import { entryHandleFromLinkCandidate, findEntryLinkMatches, isEntryHandle } from '../lib/entryLinks';
import type { EntryResolver } from '../lib/entryResolve';
import { font, radius, space, useTheme, type Colors } from '../lib/theme';
import { EntryInlineChip } from './EntryQuoteCards';

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

type SourceNode = ASTNode & { sourceInfo?: string };
type MarkdownItToken = {
  type: string;
  tag?: string;
  nesting?: number;
  content: string;
  children: MarkdownItToken[] | null;
  attrs?: [string, string][] | null;
  attrSet: (name: string, value: string) => void;
  attrJoin: (name: string, value: string) => void;
};
type MarkdownItState = {
  tokens: MarkdownItToken[];
  Token: new (type: string, tag: string, nesting: number) => MarkdownItToken;
};

const mentionHrefPrefix = 'atrium-mention:';
const mentionIdHrefPrefix = 'atrium-mention-id:';
const specialMentionHrefPrefix = 'atrium-special-mention:';
const entryHrefPrefix = 'atrium-entry:';
const mentionRe =
  /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>|<!(channel|here)>|(^|[\s(["'{<])@([a-z0-9][a-z0-9_-]{1,31})/gi;

export interface EntryReferenceMarkdownContextValue {
  resolveEntry?: EntryResolver;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

const emptyEntryReferenceContext: EntryReferenceMarkdownContextValue = {};
const EntryReferenceMarkdownContext = createContext<EntryReferenceMarkdownContextValue>(emptyEntryReferenceContext);

export function EntryReferenceMarkdownProvider({
  value,
  children,
}: {
  value: EntryReferenceMarkdownContextValue;
  children: ReactNode;
}) {
  return <EntryReferenceMarkdownContext.Provider value={value}>{children}</EntryReferenceMarkdownContext.Provider>;
}

const taskListPlugin = (md: MarkdownIt) => {
  md.core.ruler.after('inline', 'atrium_task_lists', (rawState) => {
    const state = rawState as unknown as MarkdownItState;
    let listItem: MarkdownItToken | null = null;
    for (const token of state.tokens) {
      if (token.type === 'list_item_open') {
        listItem = token;
        continue;
      }
      if (!listItem) continue;
      if (token.type !== 'inline') {
        if (token.type !== 'paragraph_open') listItem = null;
        continue;
      }

      const match = /^\[([ xX])\]\s+/.exec(token.content);
      if (!match) {
        listItem = null;
        continue;
      }

      token.content = token.content.slice(match[0].length);
      const firstChild = token.children?.[0];
      if (firstChild?.type === 'text') {
        firstChild.content = firstChild.content.slice(match[0].length);
      }
      listItem.attrSet('data-task', 'true');
      listItem.attrSet('data-checked', (match[1] ?? '').toLowerCase() === 'x' ? 'true' : 'false');
      listItem.attrJoin('class', 'task-list-item');
      listItem = null;
    }
  });
};

const mentionPlugin = (md: MarkdownIt) => {
  md.core.ruler.after('inline', 'atrium_mentions', (rawState) => {
    const state = rawState as unknown as MarkdownItState;
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !Array.isArray(token.children)) continue;
      const next: MarkdownItToken[] = [];
      for (const child of token.children) {
        if (child.type !== 'text' || !child.content) {
          next.push(child);
          continue;
        }
        let last = 0;
        mentionRe.lastIndex = 0;
        for (let match = mentionRe.exec(child.content); match; match = mentionRe.exec(child.content)) {
          const userId = match[1];
          const special = match[2];
          const legacyBoundary = match[3] ?? '';
          const handle = match[4];
          const mentionStart = match.index + legacyBoundary.length;
          if (mentionStart > last) {
            const text = new state.Token('text', '', 0);
            text.content = child.content.slice(last, mentionStart);
            next.push(text);
          }
          const open = new state.Token('link_open', 'a', 1);
          open.attrs = [
            [
              'href',
              userId
                ? `${mentionIdHrefPrefix}${userId}`
                : special
                  ? `${specialMentionHrefPrefix}${special}`
                  : `${mentionHrefPrefix}${handle}`,
            ],
          ];
          const text = new state.Token('text', '', 0);
          text.content = handle ? `@${handle}` : match[0];
          const close = new state.Token('link_close', 'a', -1);
          next.push(open, text, close);
          last = match.index + match[0].length;
        }
        if (last < child.content.length) {
          const text = new state.Token('text', '', 0);
          text.content = child.content.slice(last);
          next.push(text);
        }
      }
      token.children = next;
    }
  });
};

function tokenAttr(token: MarkdownItToken, name: string): string | null {
  return token.attrs?.find(([key]) => key === name)?.[1] ?? null;
}

function handleForEntryHref(href: string): string | null {
  const handle = entryHandleFromLinkCandidate(href);
  return handle && isEntryHandle(handle) ? handle : null;
}

const entryPlugin = (md: MarkdownIt) => {
  md.core.ruler.after('atrium_mentions', 'atrium_entries', (rawState) => {
    const state = rawState as unknown as MarkdownItState;
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !Array.isArray(token.children)) continue;
      const next: MarkdownItToken[] = [];
      let linkDepth = 0;

      for (const child of token.children) {
        if (child.type === 'link_open') {
          const href = tokenAttr(child, 'href');
          const handle = href ? handleForEntryHref(href) : null;
          if (handle) child.attrSet('href', `${entryHrefPrefix}${handle}`);
          linkDepth += 1;
          next.push(child);
          continue;
        }

        if (child.type === 'link_close') {
          linkDepth = Math.max(0, linkDepth - 1);
          next.push(child);
          continue;
        }

        if (child.type !== 'text' || !child.content || linkDepth > 0) {
          next.push(child);
          continue;
        }

        let last = 0;
        const matches = findEntryLinkMatches(child.content);
        for (const match of matches) {
          const candidateEnd = match.index + match.candidate.length;
          if (match.index > last) {
            const text = new state.Token('text', '', 0);
            text.content = child.content.slice(last, match.index);
            next.push(text);
          }
          const open = new state.Token('link_open', 'a', 1);
          open.attrs = [['href', `${entryHrefPrefix}${match.handle}`]];
          const text = new state.Token('text', '', 0);
          text.content = match.candidate;
          const close = new state.Token('link_close', 'a', -1);
          next.push(open, text, close);
          last = candidateEnd;
        }
        if (last < child.content.length) {
          const text = new state.Token('text', '', 0);
          text.content = child.content.slice(last);
          next.push(text);
        }
      }
      token.children = next;
    }
  });
};

const markdownIt = MarkdownIt({ html: false, typographer: true, linkify: true })
  .use(taskListPlugin)
  .use(mentionPlugin)
  .use(entryPlugin);

function normalizeLanguage(info: string | undefined): string {
  const raw = info?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!raw) return 'text';
  if (raw === 'js') return 'javascript';
  if (raw === 'ts') return 'typescript';
  if (raw === 'tsx') return 'typescript';
  if (raw === 'sh') return 'bash';
  if (raw === 'yml') return 'yaml';
  if (raw === 'md') return 'markdown';
  return raw;
}

function trimTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function openExternalLink(url: string): boolean {
  if (url.startsWith(mentionHrefPrefix)) return false;
  if (url.startsWith(mentionIdHrefPrefix)) return false;
  if (url.startsWith(specialMentionHrefPrefix)) return false;
  if (url.startsWith(entryHrefPrefix)) return false;
  if (!/^(https?:|mailto:|tel:)/i.test(url)) return false;
  void Linking.openURL(url).catch(() => {});
  return false;
}

function syntaxTheme(colors: Colors) {
  return {
    hljs: {
      backgroundColor: colors.bgElevated,
      color: colors.textSecondary,
    },
    'hljs-comment': { color: colors.textMuted },
    'hljs-quote': { color: colors.textMuted },
    'hljs-keyword': { color: '#ff7b72' },
    'hljs-selector-tag': { color: '#ff7b72' },
    'hljs-literal': { color: '#79c0ff' },
    'hljs-number': { color: '#79c0ff' },
    'hljs-string': { color: '#a5d6ff' },
    'hljs-title': { color: '#d2a8ff' },
    'hljs-section': { color: '#d2a8ff' },
    'hljs-built_in': { color: '#7ee787' },
    'hljs-name': { color: '#7ee787' },
    'hljs-symbol': { color: '#7ee787' },
    'hljs-attribute': { color: '#f2cc60' },
    'hljs-bullet': { color: '#f2cc60' },
    'hljs-meta': { color: '#f2cc60' },
    'hljs-addition': { color: '#aff5b4', backgroundColor: 'rgba(3, 58, 22, 0.45)' },
    'hljs-deletion': { color: '#ffdcd7', backgroundColor: 'rgba(103, 6, 12, 0.45)' },
  };
}

function CopyableCodeBlock({
  nodeKey,
  content,
  language,
  colors,
}: {
  nodeKey: string;
  content: string;
  language: string;
  colors: Colors;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const code = trimTrailingNewline(content);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const copyCode = () => {
    if (!code) return;
    selectionHaptic();
    void Clipboard.setStringAsync(code).then(() => {
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <View
      key={nodeKey}
      style={{
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderRadius: radius.sm,
        borderWidth: 1,
        marginVertical: space.xs,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          alignItems: 'center',
          borderBottomColor: colors.border,
          borderBottomWidth: 1,
          flexDirection: 'row',
          justifyContent: 'space-between',
          minHeight: 34,
          paddingLeft: space.sm,
          paddingRight: space.xs,
        }}
      >
        <Text
          style={{
            color: colors.textMuted,
            fontFamily: monoFont,
            fontSize: font.xs,
            textTransform: 'uppercase',
          }}
        >
          {language}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied code' : 'Copy code'}
          onPress={copyCode}
          style={{
            alignItems: 'center',
            borderRadius: radius.sm,
            flexDirection: 'row',
            gap: 4,
            minHeight: 30,
            paddingHorizontal: space.sm,
            justifyContent: 'center',
          }}
        >
          <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={colors.textSecondary} />
          <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </Pressable>
      </View>
      <SyntaxHighlighter
        highlighter="hljs"
        language={language}
        style={syntaxTheme(colors)}
        fontFamily={monoFont}
        fontSize={font.xs}
        PreTag={ScrollView}
        CodeTag={ScrollView}
      >
        {code}
      </SyntaxHighlighter>
    </View>
  );
}

function markdownStyles(colors: Colors, variant: 'session' | 'message' | 'compact' = 'session') {
  const compact = variant === 'compact';
  const bodyText: TextStyle = {
    color: colors.text,
    fontSize: font.md,
    lineHeight: font.md * 1.4,
  };
  const codeContainer: ViewStyle = {
    alignSelf: 'stretch',
    backgroundColor: colors.bgElevated,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginVertical: space.xs,
    overflow: 'hidden',
  };

  return {
    body: { gap: 0 },
    text: bodyText,
    textgroup: bodyText,
    paragraph: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginBottom: space.xs,
      marginTop: space.xs,
    },
    strong: { color: colors.text, fontWeight: '800' },
    em: { color: colors.text, fontStyle: 'italic' },
    s: { textDecorationLine: 'line-through' },
    heading1: {
      ...bodyText,
      color: colors.text,
      fontSize: variant === 'session' ? font.xl : font.lg,
      fontWeight: '900',
      marginVertical: space.sm,
    },
    heading2: {
      ...bodyText,
      color: colors.text,
      fontSize: variant === 'session' ? font.lg : font.md,
      fontWeight: '800',
      marginVertical: space.sm,
    },
    heading3: { ...bodyText, color: colors.text, fontSize: font.md, fontWeight: '800', marginVertical: space.sm },
    heading4: { ...bodyText, color: colors.textSecondary, fontWeight: '800', marginVertical: space.xs },
    heading5: {
      ...bodyText,
      color: colors.textSecondary,
      fontSize: font.sm,
      fontWeight: '800',
      marginVertical: space.xs,
    },
    heading6: { ...bodyText, color: colors.textMuted, fontSize: font.xs, fontWeight: '800', marginVertical: space.xs },
    bullet_list: { marginVertical: compact ? 0 : space.xs },
    ordered_list: { marginVertical: compact ? 0 : space.xs },
    list_item: { marginVertical: compact ? 0 : 2 },
    bullet_list_icon: { color: colors.textMuted, fontSize: font.md, lineHeight: font.md * 1.4 },
    ordered_list_icon: { color: colors.textMuted, fontSize: font.md, lineHeight: font.md * 1.4 },
    bullet_list_content: { flex: 1 },
    ordered_list_content: { flex: 1 },
    blockquote: {
      borderLeftColor: colors.border,
      borderLeftWidth: 2,
      marginVertical: space.sm,
      paddingLeft: space.md,
    },
    hr: {
      backgroundColor: colors.border,
      height: 1,
      marginVertical: space.md,
    },
    link: { color: colors.accent, textDecorationLine: 'underline' },
    code_inline: {
      backgroundColor: colors.bgElevated,
      borderRadius: radius.sm,
      color: colors.codeAccent,
      fontFamily: monoFont,
      fontSize: font.sm,
      paddingHorizontal: 4,
      paddingVertical: 1,
    },
    code_block: codeContainer,
    fence: codeContainer,
    table: {
      alignSelf: 'stretch',
      borderColor: colors.border,
      borderRadius: radius.sm,
      borderWidth: 1,
      marginVertical: space.sm,
      overflow: 'hidden',
    },
    tr: { borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: 'row' },
    th: { backgroundColor: colors.bgElevated, flex: 1, padding: space.sm },
    td: { flex: 1, padding: space.sm },
  } as Record<string, TextStyle | ViewStyle>;
}

function makeRules(
  colors: Colors,
  variant: 'session' | 'message' | 'compact',
  meHandle: string | undefined,
  meId: string | undefined,
  resolveUser: ((id: string) => UserRef | undefined) | undefined,
  entryReferences: EntryReferenceMarkdownContextValue,
): RenderRules {
  const highlightedCode = (node: ASTNode) => {
    const sourceNode = node as SourceNode;
    return (
      <CopyableCodeBlock
        key={node.key}
        nodeKey={node.key}
        content={node.content}
        language={normalizeLanguage(sourceNode.sourceInfo)}
        colors={colors}
      />
    );
  };

  return {
    link: (node, children) => {
      const href = typeof node.attributes.href === 'string' ? node.attributes.href : '';
      if (href.startsWith(entryHrefPrefix)) {
        const handle = href.slice(entryHrefPrefix.length);
        if (isEntryHandle(handle)) {
          return (
            <EntryInlineChip
              key={node.key}
              handle={handle}
              compact={variant === 'compact'}
              resolveEntry={entryReferences.resolveEntry}
              onOpenChannel={entryReferences.onOpenChannel}
              onOpenSession={entryReferences.onOpenSession}
            />
          );
        }
      }

      if (!href.startsWith(mentionHrefPrefix)) {
        if (href.startsWith(mentionIdHrefPrefix)) {
          const userId = href.slice(mentionIdHrefPrefix.length);
          const user = resolveUser?.(userId);
          const isMe = meId != null && userId.toLowerCase() === meId.toLowerCase();
          return (
            <Text
              key={node.key}
              style={{
                color: user ? colors.accent : colors.textMuted,
                fontWeight: '700',
                ...(isMe ? { backgroundColor: colors.accentBg } : {}),
              }}
            >
              @{user?.displayName ?? 'unknown'}
            </Text>
          );
        }
        if (href.startsWith(specialMentionHrefPrefix)) {
          const name = href.slice(specialMentionHrefPrefix.length);
          return (
            <Text
              key={node.key}
              style={{ color: colors.onMention, backgroundColor: colors.mention, fontWeight: '800' }}
            >
              @{name}
            </Text>
          );
        }
        if (variant === 'compact') {
          return (
            <Text key={node.key} style={{ color: colors.accent }}>
              {children}
            </Text>
          );
        }
        return (
          <Text
            key={node.key}
            onPress={() => {
              openExternalLink(href);
            }}
            style={{ color: colors.accent, textDecorationLine: 'underline' }}
          >
            {children}
          </Text>
        );
      }
      const handle = href.slice(mentionHrefPrefix.length);
      const isMe = meHandle != null && handle.toLowerCase() === meHandle.toLowerCase();
      return (
        <Text
          key={node.key}
          style={{
            color: colors.accent,
            fontWeight: '700',
            ...(isMe ? { backgroundColor: colors.accentBg } : {}),
          }}
        >
          {children}
        </Text>
      );
    },
    fence: highlightedCode,
    code_block: highlightedCode,
    list_item: (node, children, parentNodes, styles, inheritedStyles = {}) => {
      if (node.attributes['data-task'] !== 'true') {
        return renderRules.list_item?.(node, children, parentNodes, styles, inheritedStyles) ?? null;
      }
      const checked = node.attributes['data-checked'] === 'true';
      return (
        <View
          key={node.key}
          style={{
            flexDirection: 'row',
            gap: space.sm,
            marginVertical: 2,
          }}
        >
          <Text
            accessibilityLabel={checked ? 'Checked task' : 'Unchecked task'}
            style={{
              color: checked ? colors.accent : colors.textMuted,
              fontFamily: monoFont,
              fontSize: font.sm,
              lineHeight: font.md * 1.4,
            }}
          >
            {checked ? '[x]' : '[ ]'}
          </Text>
          <View style={{ flex: 1 }}>{children}</View>
        </View>
      );
    },
  };
}

function plainTextFallback(text: string, colors: Colors) {
  return <Text style={{ color: colors.text, fontSize: font.md, lineHeight: font.md * 1.4 }}>{text}</Text>;
}

class MarkdownBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { hasError: boolean; resetKey: string }
> {
  state = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { hasError: boolean; resetKey: string }) {
    if (props.resetKey !== state.resetKey) return { hasError: false, resetKey: props.resetKey };
    return null;
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

export const SessionMarkdown = memo(function SessionMarkdown({ text }: { text: string }) {
  return <MarkdownText text={text} variant="session" />;
});

export const MarkdownText = memo(function MarkdownText({
  text,
  variant = 'message',
  meHandle,
  meId,
  resolveUser,
}: {
  text: string;
  variant?: 'session' | 'message' | 'compact';
  meHandle?: string | null;
  meId?: string | null;
  resolveUser?: (id: string) => UserRef | undefined;
}) {
  const { colors } = useTheme();
  const entryReferences = useContext(EntryReferenceMarkdownContext);
  const styles = useMemo(() => markdownStyles(colors, variant), [colors, variant]);
  const rules = useMemo(
    () => makeRules(colors, variant, meHandle ?? undefined, meId ?? undefined, resolveUser, entryReferences),
    [colors, variant, meHandle, meId, resolveUser, entryReferences],
  );
  const source = variant === 'compact' ? compactMarkdownSource(text) : text;

  return (
    <MarkdownBoundary fallback={plainTextFallback(text, colors)} resetKey={text}>
      <MarkdownDisplay markdownit={markdownIt} style={styles} rules={rules} onLinkPress={openExternalLink}>
        {source}
      </MarkdownDisplay>
    </MarkdownBoundary>
  );
});
