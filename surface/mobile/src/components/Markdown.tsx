import { Component, memo, useMemo, type ReactNode } from 'react';
import { Linking, Platform, ScrollView, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import MarkdownDisplay, {
  MarkdownIt,
  renderRules,
  type ASTNode,
  type RenderRules,
} from 'react-native-markdown-display';
// @ts-expect-error react-native-syntax-highlighter does not publish TypeScript declarations.
import SyntaxHighlighter from 'react-native-syntax-highlighter';
import { font, radius, space, useTheme, type Colors } from '../lib/theme';

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

type SourceNode = ASTNode & { sourceInfo?: string };
type MarkdownItToken = {
  type: string;
  content: string;
  children: MarkdownItToken[] | null;
  attrSet: (name: string, value: string) => void;
  attrJoin: (name: string, value: string) => void;
};

const taskListPlugin = (md: MarkdownIt) => {
  md.core.ruler.after('inline', 'atrium_task_lists', (state: { tokens: MarkdownItToken[] }) => {
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

const markdownIt = MarkdownIt({ typographer: true, linkify: true }).use(taskListPlugin);

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

function markdownStyles(colors: Colors) {
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
    heading1: { ...bodyText, color: colors.text, fontSize: font.xl, fontWeight: '900', marginVertical: space.sm },
    heading2: { ...bodyText, color: colors.text, fontSize: font.lg, fontWeight: '800', marginVertical: space.sm },
    heading3: { ...bodyText, color: colors.text, fontSize: font.md, fontWeight: '800', marginVertical: space.sm },
    heading4: { ...bodyText, color: colors.textSecondary, fontWeight: '800', marginVertical: space.xs },
    heading5: { ...bodyText, color: colors.textSecondary, fontSize: font.sm, fontWeight: '800', marginVertical: space.xs },
    heading6: { ...bodyText, color: colors.textMuted, fontSize: font.xs, fontWeight: '800', marginVertical: space.xs },
    bullet_list: { marginVertical: space.xs },
    ordered_list: { marginVertical: space.xs },
    list_item: { marginVertical: 2 },
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

function makeRules(colors: Colors): RenderRules {
  const highlightedCode = (node: ASTNode) => {
    const sourceNode = node as SourceNode;
    return (
      <View
        key={node.key}
        style={{
          backgroundColor: colors.bgElevated,
          borderColor: colors.border,
          borderRadius: radius.sm,
          borderWidth: 1,
          marginVertical: space.xs,
          overflow: 'hidden',
        }}
      >
        <SyntaxHighlighter
          highlighter="hljs"
          language={normalizeLanguage(sourceNode.sourceInfo)}
          style={syntaxTheme(colors)}
          fontFamily={monoFont}
          fontSize={font.xs}
          PreTag={ScrollView}
          CodeTag={ScrollView}
        >
          {trimTrailingNewline(node.content)}
        </SyntaxHighlighter>
      </View>
    );
  };

  return {
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
  return (
    <Text style={{ color: colors.text, fontSize: font.md, lineHeight: font.md * 1.4 }}>
      {text}
    </Text>
  );
}

class MarkdownBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { hasError: boolean; resetKey: string }
> {
  state = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { hasError: boolean; resetKey: string },
  ) {
    if (props.resetKey !== state.resetKey) return { hasError: false, resetKey: props.resetKey };
    return null;
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

export const SessionMarkdown = memo(function SessionMarkdown({ text }: { text: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => markdownStyles(colors), [colors]);
  const rules = useMemo(() => makeRules(colors), [colors]);

  return (
    <MarkdownBoundary fallback={plainTextFallback(text, colors)} resetKey={text}>
      <MarkdownDisplay
        markdownit={markdownIt}
        style={styles}
        rules={rules}
        onLinkPress={openExternalLink}
      >
        {text}
      </MarkdownDisplay>
    </MarkdownBoundary>
  );
});
