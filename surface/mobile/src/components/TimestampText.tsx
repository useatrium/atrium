import { useEffect, useState } from 'react';
import { Text, type TextProps } from 'react-native';
import { formatExactTimestamp } from '@atrium/surface-client';

type TimestampTextProps = Omit<TextProps, 'accessibilityLabel' | 'accessibilityRole' | 'children' | 'onPress'> & {
  iso: string;
  text: string;
};

export function TimestampText({ iso, text, numberOfLines, ...props }: TimestampTextProps) {
  const exact = formatExactTimestamp(iso);
  const [showExact, setShowExact] = useState(false);

  useEffect(() => {
    setShowExact(false);
  }, [iso, text]);

  const visibleText = showExact && exact ? exact : text;
  const canToggle = exact.length > 0 && text.length > 0;

  return (
    <Text
      {...props}
      accessibilityRole={canToggle ? 'button' : 'text'}
      accessibilityLabel={exact ? `${text}. Exact time: ${exact}` : text}
      numberOfLines={showExact && exact ? undefined : numberOfLines}
      onPress={canToggle ? () => setShowExact((current) => !current) : undefined}
    >
      {visibleText}
    </Text>
  );
}
