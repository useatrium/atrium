import { Ionicons } from '@expo/vector-icons';
import type { HubFile } from '@atrium/surface-client';
import { agentPathBasename, type AgentPathRef } from '@atrium/surface-client/agent-paths';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text } from 'react-native';
import { font, radius, space, useTheme } from '../lib/theme';

export interface AgentFileMarkdownContextValue {
  serverUrl?: string;
  fileHeaders?: Record<string, string>;
  channelId?: string | null;
  onOpenFile?: (file: HubFile) => void;
}

const AgentFileMarkdownContext = createContext<AgentFileMarkdownContextValue>({});

export function AgentFileMarkdownProvider({
  value,
  children,
}: {
  value: AgentFileMarkdownContextValue;
  children: ReactNode;
}) {
  return <AgentFileMarkdownContext.Provider value={value}>{children}</AgentFileMarkdownContext.Provider>;
}

function canonicalPathFor(ref: AgentPathRef, channelId: string | null | undefined): string | null {
  if (ref.kind !== 'workspace-relative') return ref.canonicalPath;
  if (!channelId) return null;
  return `shared/channels/${channelId}/${ref.relPath}`;
}

export function FilePathChip({ pathRef, compact = false }: { pathRef: AgentPathRef; compact?: boolean }) {
  const { colors } = useTheme();
  const { serverUrl, fileHeaders, channelId, onOpenFile } = useContext(AgentFileMarkdownContext);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const canonicalPath = useMemo(() => canonicalPathFor(pathRef, channelId), [channelId, pathRef]);
  const label = agentPathBasename(pathRef);
  const unavailable = missing || !canonicalPath || !serverUrl || !onOpenFile;

  const open = async () => {
    if (unavailable || loading || !canonicalPath || !serverUrl || !onOpenFile) return;
    setLoading(true);
    try {
      const response = await fetch(
        `${serverUrl.replace(/\/+$/, '')}/api/files/by-path?path=${encodeURIComponent(canonicalPath)}`,
        { headers: fileHeaders },
      );
      if (response.status === 404) {
        setMissing(true);
        return;
      }
      if (!response.ok) return;
      const file = (await response.json()) as HubFile;
      if (file?.artifactId) onOpenFile(file);
    } catch {
      // A transient network failure should remain retryable.
    } finally {
      setLoading(false);
    }
  };

  if (compact) {
    return (
      <Text
        accessibilityRole="button"
        accessibilityLabel={unavailable ? `File unavailable: ${label}` : `Open file ${label}`}
        accessibilityState={{ disabled: unavailable || loading }}
        disabled={unavailable || loading}
        onPress={() => void open()}
        style={{ color: unavailable ? colors.textFaint : colors.accent, fontWeight: '600' }}
        numberOfLines={1}
      >
        {label}
      </Text>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unavailable ? `File unavailable: ${label}` : `Open file ${label}`}
      accessibilityState={{ disabled: unavailable || loading, busy: loading }}
      disabled={unavailable || loading}
      onPress={() => void open()}
      hitSlop={6}
      style={({ pressed }) => ({
        alignItems: 'center',
        alignSelf: 'center',
        backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
        borderColor: unavailable ? colors.borderSoft : colors.border,
        borderRadius: radius.pill,
        borderWidth: 1,
        flexDirection: 'row',
        flexShrink: 1,
        gap: space.xs,
        marginHorizontal: space.xxs,
        marginVertical: 1,
        maxWidth: '100%',
        minHeight: 24,
        opacity: unavailable ? 0.62 : 1,
        paddingHorizontal: 7,
        paddingVertical: space.xxs,
      })}
    >
      <Ionicons name="document-outline" size={13} color={unavailable ? colors.textFaint : colors.textMuted} />
      <Text
        style={{
          color: unavailable ? colors.textMuted : colors.textSecondary,
          flexShrink: 1,
          fontSize: font.xs,
          fontWeight: '700',
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
