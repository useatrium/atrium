import { useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import type { HubFile } from '@atrium/surface-client';
import { font, space, useTheme } from '../lib/theme';

interface SlideText {
  number: number;
  lines: string[];
}

type PptxState =
  | { status: 'loading'; slides: null; message: null }
  | { status: 'ready'; slides: SlideText[]; message: null }
  | { status: 'error'; slides: null; message: string };

function formatSize(bytes: number | null): string {
  if (bytes == null) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 10)));
}

function textRuns(xml: string): string[] {
  const runs: string[] = [];
  const runPattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  let match = runPattern.exec(xml);
  while (match) {
    runs.push(unescapeXml(match[1] ?? ''));
    match = runPattern.exec(xml);
  }
  return runs;
}

function extractSlideLines(xml: string): string[] {
  const lines: string[] = [];
  const paragraphPattern = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let match = paragraphPattern.exec(xml);
  while (match) {
    const line = textRuns(match[1] ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (line.length > 0) lines.push(line);
    match = paragraphPattern.exec(xml);
  }
  if (lines.length > 0) return lines;
  return textRuns(xml)
    .map((run) => run.replace(/\s+/g, ' ').trim())
    .filter((run) => run.length > 0);
}

function slideNumber(path: string): number {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

async function extractSlides(buffer: ArrayBuffer): Promise<SlideText[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
  const slides: SlideText[] = [];
  for (const entry of entries) {
    const xml = await entry.async('text');
    slides.push({ number: slideNumber(entry.name), lines: extractSlideLines(xml) });
  }
  return slides;
}

function LoadingState() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
      <ActivityIndicator color={colors.textMuted} />
      <Text style={{ color: colors.textMuted, fontSize: font.sm }}>Loading presentation...</Text>
    </View>
  );
}

function EmptyState({
  file,
  downloadUrl,
  message,
}: {
  file: HubFile;
  downloadUrl: string;
  message: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md }}>
      <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '800', textAlign: 'center' }} numberOfLines={2}>
        {file.name}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
        {file.mime ?? 'PowerPoint presentation'}, {formatSize(file.sizeBytes)}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: font.sm, lineHeight: 20, textAlign: 'center' }}>
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Download presentation"
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

export function PptxPane(props: {
  file: HubFile;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
}): JSX.Element {
  const { file, fileContentUrl, fileHeaders } = props;
  const { colors } = useTheme();
  const downloadUrl = fileContentUrl(file.artifactId);
  const [state, setState] = useState<PptxState>({ status: 'loading', slides: null, message: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', slides: null, message: null });
    fetch(downloadUrl, { headers: fileHeaders })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Presentation unavailable (${res.status}${res.statusText ? ` ${res.statusText}` : ''}).`);
        return res.arrayBuffer();
      })
      .then((buffer) => extractSlides(buffer))
      .then((slides) => {
        if (!cancelled) setState({ status: 'ready', slides, message: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            slides: null,
            message: err instanceof Error ? err.message : 'Could not load presentation.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [downloadUrl, fileHeaders]);

  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') {
    return <EmptyState file={file} downloadUrl={downloadUrl} message={state.message} />;
  }

  const hasSlideText = state.slides.some((slide) => slide.lines.length > 0);
  if (!hasSlideText) {
    return (
      <EmptyState
        file={file}
        downloadUrl={downloadUrl}
        message="No preview available - download to view the full presentation."
      />
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, gap: space.md }}
    >
      <View style={{ gap: space.xs }}>
        <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '800' }}>Simplified preview</Text>
        <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
          Slide text only - download for full fidelity.
        </Text>
      </View>
      {state.slides.map((slide) => (
        <View
          key={slide.number}
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.bgElevated,
            padding: space.md,
            gap: space.sm,
          }}
        >
          <View
            style={{
              alignSelf: 'flex-start',
              borderRadius: 999,
              backgroundColor: colors.accentBg,
              paddingHorizontal: space.sm,
              paddingVertical: space.xs,
            }}
          >
            <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '800' }}>Slide {slide.number}</Text>
          </View>
          <View style={{ gap: space.xs }}>
            {slide.lines.length > 0 ? (
              slide.lines.map((line, index) => (
                <Text key={`${slide.number}-${index}`} style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>
                  {line}
                </Text>
              ))
            ) : (
              <Text style={{ color: colors.textMuted, fontSize: font.sm, lineHeight: 20 }}>No extractable text.</Text>
            )}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}
