import { useEffect, useMemo, useState, type JSX } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { Api, HubFile } from '@atrium/surface-client';
import { font, space, useTheme } from '../lib/theme';

type PreviewState =
  | { status: 'loading'; html: null; message: null }
  | { status: 'ready'; html: string; message: null }
  | { status: 'error'; html: null; message: string };

function extension(file: HubFile): string {
  const name = file.name || file.path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function rendererFor(file: HubFile): 'html-app' | 'react-jsx' {
  const ext = extension(file);
  return ext === 'jsx' || ext === 'tsx' ? 'react-jsx' : 'html-app';
}

function statusMessage(res: Response): string {
  const label = res.statusText ? ` ${res.statusText}` : '';
  return `Preview unavailable (${res.status}${label}).`;
}

function LoadingState({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
      <ActivityIndicator color={colors.textMuted} />
      <Text style={{ color: colors.textMuted, fontSize: font.sm }}>{label}</Text>
    </View>
  );
}

function ErrorState({ file, downloadUrl, message }: { file: HubFile; downloadUrl: string; message: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md }}>
      <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '800', textAlign: 'center' }} numberOfLines={2}>
        {file.name}
      </Text>
      <Text style={{ color: colors.danger, fontSize: font.sm, lineHeight: 20, textAlign: 'center' }}>{message}</Text>
      <Text style={{ color: colors.textMuted, fontSize: font.sm, lineHeight: 20, textAlign: 'center' }}>
        Download or open externally to view the full file.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Download file"
        onPress={() => {
          void Linking.openURL(downloadUrl).catch(() => {});
        }}
        style={{
          minHeight: 44,
          justifyContent: 'center',
          paddingHorizontal: space.lg,
        }}
      >
        <Text style={{ color: colors.accent, fontSize: font.md, fontWeight: '800' }}>Download</Text>
      </Pressable>
    </View>
  );
}

export function AppPreviewPane(props: { file: HubFile; api: Api; fileHeaders?: Record<string, string> }): JSX.Element {
  const { api, file, fileHeaders } = props;
  const { colors } = useTheme();
  const renderer = useMemo(() => rendererFor(file), [file]);
  const previewUrl = useMemo(() => api.filePreviewUrl(file.artifactId, renderer), [api, file.artifactId, renderer]);
  const downloadUrl = useMemo(() => api.fileContentUrl(file.artifactId), [api, file.artifactId]);
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading', html: null, message: null });
  const [webLoading, setWebLoading] = useState(false);
  const [webError, setWebError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview({ status: 'loading', html: null, message: null });
    setWebLoading(false);
    setWebError(null);

    fetch(previewUrl, {
      headers: {
        ...fileHeaders,
        'sec-fetch-dest': 'iframe',
        'sec-fetch-mode': 'navigate',
      },
    })
      .then(async (res) => {
        const html = await res.text();
        if (!res.ok) throw new Error(statusMessage(res));
        return html;
      })
      .then((html) => {
        if (!cancelled) {
          setPreview({ status: 'ready', html, message: null });
          setWebLoading(true);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreview({
            status: 'error',
            html: null,
            message: err instanceof Error ? err.message : 'Preview unavailable.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileHeaders, previewUrl]);

  if (preview.status === 'loading') return <LoadingState label="Loading preview..." />;
  if (preview.status === 'error') {
    return <ErrorState file={file} downloadUrl={downloadUrl} message={preview.message} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <WebView
        source={{ html: preview.html, baseUrl: previewUrl }}
        javaScriptEnabled
        originWhitelist={['*']}
        style={{ flex: 1, backgroundColor: colors.bg }}
        containerStyle={{ backgroundColor: colors.bg }}
        onLoadStart={() => {
          setWebLoading(true);
        }}
        onLoadEnd={() => {
          setWebLoading(false);
        }}
        onError={(event) => {
          setWebLoading(false);
          setWebError(event.nativeEvent.description || 'Preview failed to load.');
        }}
        onHttpError={(event) => {
          setWebLoading(false);
          setWebError(`Preview request failed (${event.nativeEvent.statusCode}).`);
        }}
      />
      {webLoading ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.bg,
            gap: space.sm,
          }}
        >
          <ActivityIndicator color={colors.textMuted} />
          <Text style={{ color: colors.textMuted, fontSize: font.sm }}>Rendering preview...</Text>
        </View>
      ) : null}
      {webError ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.bgElevated,
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: font.xs }}>{webError}</Text>
        </View>
      ) : null}
    </View>
  );
}
