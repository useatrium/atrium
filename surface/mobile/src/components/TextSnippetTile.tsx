import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import type { HubFile } from '@atrium/surface-client';
import { canPreviewTextSnippet, fetchArtifactTextSnippet } from '../lib/artifactTextSnippets';
import { font, space, useTheme } from '../lib/theme';

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function TextSnippetTile({
  file,
  fileContentUrl,
  fileHeaders,
  fallback,
}: {
  file: HubFile;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
  fallback: ReactNode;
}) {
  const { colors } = useTheme();
  const [snippet, setSnippet] = useState<string | null>(null);

  useEffect(() => {
    if (!canPreviewTextSnippet(file)) {
      setSnippet(null);
      return;
    }

    let cancelled = false;
    setSnippet(null);
    void fetchArtifactTextSnippet({
      artifactId: file.artifactId,
      versionSeq: file.versionSeq,
      fileContentUrl,
      fileHeaders,
    }).then((nextSnippet) => {
      if (!cancelled) setSnippet(nextSnippet);
    });

    return () => {
      cancelled = true;
    };
  }, [file, fileContentUrl, fileHeaders]);

  if (!canPreviewTextSnippet(file) || snippet == null) return <>{fallback}</>;

  return (
    <View
      style={{
        width: '100%',
        height: '100%',
        paddingHorizontal: space.sm,
        paddingVertical: space.sm,
        backgroundColor: colors.bg,
      }}
    >
      <Text
        style={{
          color: colors.textMuted,
          fontFamily: monoFont,
          fontSize: font.xs,
          lineHeight: 16,
        }}
        numberOfLines={6}
      >
        {snippet}
      </Text>
    </View>
  );
}
