export const syntaxTheme = {
  dark: {
    comment: '#8f8f98',
    keyword: '#ff7b72',
    literal: '#79c0ff',
    string: '#a5d6ff',
    title: '#d2a8ff',
    builtIn: '#7ee787',
    attribute: '#f2cc60',
    addition: '#aff5b4',
    additionBackground: 'rgba(3, 58, 22, 0.45)',
    deletion: '#ffdcd7',
    deletionBackground: 'rgba(103, 6, 12, 0.45)',
  },
  light: {
    comment: '#656d76',
    keyword: '#cf222e',
    literal: '#0550ae',
    string: '#0a3069',
    title: '#8250df',
    builtIn: '#116329',
    attribute: '#953800',
    addition: '#116329',
    additionBackground: '#dafbe1',
    deletion: '#82071e',
    deletionBackground: '#ffebe9',
  },
} as const;

export type SyntaxTheme = (typeof syntaxTheme)[keyof typeof syntaxTheme];

export function createHljsStyle(
  theme: SyntaxTheme,
  root: { backgroundColor: string; color: string },
): Record<string, { backgroundColor?: string; color?: string }> {
  return {
    hljs: root,
    'hljs-comment': { color: theme.comment },
    'hljs-quote': { color: theme.comment },
    'hljs-keyword': { color: theme.keyword },
    'hljs-selector-tag': { color: theme.keyword },
    'hljs-subst': { color: theme.keyword },
    'hljs-literal': { color: theme.literal },
    'hljs-number': { color: theme.literal },
    'hljs-attr': { color: theme.literal },
    'hljs-template-variable': { color: theme.literal },
    'hljs-variable': { color: theme.literal },
    'hljs-doctag': { color: theme.string },
    'hljs-string': { color: theme.string },
    'hljs-section': { color: theme.title },
    'hljs-selector-id': { color: theme.title },
    'hljs-title': { color: theme.title },
    'hljs-built_in': { color: theme.builtIn },
    'hljs-name': { color: theme.builtIn },
    'hljs-symbol': { color: theme.builtIn },
    'hljs-attribute': { color: theme.attribute },
    'hljs-bullet': { color: theme.attribute },
    'hljs-meta': { color: theme.attribute },
    'hljs-selector-attr': { color: theme.attribute },
    'hljs-selector-class': { color: theme.attribute },
    'hljs-addition': { color: theme.addition, backgroundColor: theme.additionBackground },
    'hljs-deletion': { color: theme.deletion, backgroundColor: theme.deletionBackground },
  };
}
