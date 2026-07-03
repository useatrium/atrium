import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { font, useTheme } from '../lib/theme';
import { MarkdownText } from './Markdown';

const COLLAPSE_LINE_THRESHOLD = 16;
const COLLAPSE_CHAR_THRESHOLD = 1800;

/** Message text with full Markdown rendering and compact chat typography. */
export function MessageText({ text, meHandle, muted }: { text: string; meHandle: string | null; muted?: boolean }) {
  const { colors } = useTheme();
  const shouldCollapse =
    text.length > COLLAPSE_CHAR_THRESHOLD || text.split(/\r\n|\r|\n/).length > COLLAPSE_LINE_THRESHOLD;
  const [expanded, setExpanded] = useState(!shouldCollapse);

  return (
    <View style={{ alignSelf: 'stretch', opacity: muted ? 0.65 : 1 }}>
      <View
        style={
          shouldCollapse && !expanded
            ? { maxHeight: 320, overflow: 'hidden', alignSelf: 'stretch' }
            : { alignSelf: 'stretch' }
        }
      >
        <MarkdownText text={text} variant="message" meHandle={meHandle} />
      </View>
      {shouldCollapse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Show less' : 'Show more'}
          onPress={() => setExpanded((value) => !value)}
          style={{ alignSelf: 'flex-start', minHeight: 28, justifyContent: 'center' }}
        >
          <Text style={{ color: colors.accent, fontSize: font.sm, fontWeight: '700' }}>
            {expanded ? 'Show less' : 'Show more'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
