import { Linking, Text } from 'react-native';
import { colors, font } from '../lib/theme';

const TOKEN_RE = /(https?:\/\/[^\s<>"')\]]+)|(@[a-z0-9][a-z0-9_-]{1,31})/gi;

/** Plain text with linkified URLs and highlighted @mentions. */
export function MessageText({
  text,
  meHandle,
  muted,
}: {
  text: string;
  meHandle: string | null;
  muted?: boolean;
}) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    const tok = m[0];
    if (m[1]) {
      parts.push(
        <Text
          key={`l${i++}`}
          style={{ color: colors.accent, textDecorationLine: 'underline' }}
          onPress={() => Linking.openURL(tok).catch(() => {})}
          suppressHighlighting
        >
          {tok}
        </Text>,
      );
    } else {
      const isMe = meHandle != null && tok.slice(1).toLowerCase() === meHandle.toLowerCase();
      parts.push(
        <Text
          key={`m${i++}`}
          style={{
            color: colors.accent,
            fontWeight: '600',
            ...(isMe ? { backgroundColor: colors.accentBg } : {}),
          }}
        >
          {tok}
        </Text>,
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <Text
      style={{
        color: muted ? colors.textMuted : colors.text,
        fontSize: font.md,
        lineHeight: 21,
      }}
    >
      {parts}
    </Text>
  );
}
