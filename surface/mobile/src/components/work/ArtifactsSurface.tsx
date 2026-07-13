// Artifacts work-surface (mobile) — gallery of captured work-product files,
// the RN counterpart of web's ArtifactsSurface. Pure/prop-driven (the session
// screen supplies artifactUri + imageHeaders from the chat context) so it
// renders in tests without a ChatProvider. Bytes are served by the same route
// the web uses: GET /api/sessions/:id/artifacts/by-path?path=...
import { useMemo } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import type { Artifact, ArtifactKind } from '@atrium/centaur-client';
import { font, radius, space, useTheme, type Colors } from '../../lib/theme';

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function kindColor(kind: ArtifactKind, colors: Colors): string {
  if (kind === 'created') return colors.online;
  if (kind === 'deleted') return colors.danger;
  return colors.textSecondary; // modified
}

function ArtifactTile({
  artifact,
  artifactUri,
  imageHeaders,
}: {
  artifact: Artifact;
  artifactUri: (artifact: Artifact) => string;
  imageHeaders: Record<string, string>;
}) {
  const { colors } = useTheme();
  const isImage = (artifact.mime || '').startsWith('image/') && artifact.ref != null;
  const label = (artifact.mime?.split('/')?.[1] || 'file').toUpperCase().slice(0, 6);
  return (
    <View
      testID="artifact-tile"
      style={{
        width: '48%',
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      <View style={{ height: 96, backgroundColor: colors.bgInput, alignItems: 'center', justifyContent: 'center' }}>
        {isImage ? (
          <Image
            accessibilityIgnoresInvertColors
            accessibilityLabel={basename(artifact.path)}
            source={{ uri: artifactUri(artifact), headers: imageHeaders }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        ) : (
          <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800', letterSpacing: 1 }}>
            {artifact.ref == null ? 'NOT CAPTURED' : label}
          </Text>
        )}
      </View>
      <View style={{ padding: space.sm, gap: space.xxs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: kindColor(artifact.kind, colors) }} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: font.xs, fontWeight: '600' }}>
            {basename(artifact.path)}
          </Text>
        </View>
        <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
          {artifact.ref == null ? 'not captured · too large' : formatBytes(artifact.size)}
        </Text>
      </View>
    </View>
  );
}

export function ArtifactsSurface({
  artifacts,
  artifactUri,
  imageHeaders,
}: {
  artifacts: Artifact[];
  /** Build the byte URL for an artifact path (the session screen binds sessionId). */
  artifactUri: (artifact: Artifact) => string;
  imageHeaders: Record<string, string>;
}) {
  const { colors } = useTheme();
  // collectArtifacts already returns newest-last in capture order; show newest first.
  const ordered = useMemo(() => [...artifacts].reverse(), [artifacts]);

  if (ordered.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No artifacts captured.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{
        padding: space.md,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.sm,
      }}
    >
      {ordered.map((artifact) => (
        <ArtifactTile key={artifact.id} artifact={artifact} artifactUri={artifactUri} imageHeaders={imageHeaders} />
      ))}
    </ScrollView>
  );
}
