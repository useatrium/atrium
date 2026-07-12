import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import type { Api, VoiceMeta } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../lib/theme';
import { formatVoiceDuration } from '../lib/voice';

interface VoiceMessageProps {
  voice: VoiceMeta;
  api: Api;
  fileUrl: (id: string) => string;
  fileHeaders?: Record<string, string>;
}

const DEFAULT_BARS = [
  0.28, 0.48, 0.34, 0.68, 0.4, 0.56, 0.32, 0.74, 0.46, 0.62, 0.3, 0.52, 0.36, 0.7, 0.42, 0.58, 0.26, 0.5, 0.38, 0.64,
  0.44, 0.72, 0.34, 0.54,
];

export function VoiceMessage({ voice, api, fileUrl, fileHeaders }: VoiceMessageProps) {
  const { colors } = useTheme();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const source = useMemo(
    () => ({ uri: fileUrl(voice.fileId), headers: fileHeaders }),
    [fileHeaders, fileUrl, voice.fileId],
  );
  const player = useAudioPlayer(source, { updateInterval: 150 });
  const status = useAudioPlayerStatus(player);
  const durationMs = voice.durationMs > 0 ? voice.durationMs : Math.round(status.duration * 1000);
  const progress = durationMs > 0 ? Math.max(0, Math.min(1, (status.currentTime * 1000) / durationMs)) : 0;
  const bars = voice.waveform && voice.waveform.length > 0 ? voice.waveform : DEFAULT_BARS;

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
    });
  }, []);

  useEffect(() => {
    if (status.didJustFinish) player.seekTo(0);
  }, [player, status.didJustFinish]);

  useEffect(() => {
    if (voice.transcript.status !== 'failed') {
      setRetrying(false);
      setRetryError(false);
    }
  }, [voice.transcript.status]);

  const toggle = () => {
    if (status.playing) {
      player.pause();
      return;
    }
    if (durationMs > 0 && progress >= 0.98) player.seekTo(0);
    player.play();
  };

  const retryTranscript = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(false);
    try {
      await api.retryTranscript(voice.fileId);
    } catch {
      setRetryError(true);
      setRetrying(false);
    }
  };

  return (
    <View
      style={{
        marginTop: 4,
        gap: 6,
        alignSelf: 'flex-start',
        maxWidth: 300,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.sm,
          paddingVertical: space.sm,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
          backgroundColor: colors.bgElevated,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? 'Pause voice message' : 'Play voice message'}
          onPress={toggle}
          hitSlop={8}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: colors.accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={status.playing ? 'pause' : 'play'}
            size={18}
            color={colors.onAccent}
            style={status.playing ? undefined : { marginLeft: 2 }}
          />
        </Pressable>
        <View style={{ flex: 1, minWidth: 150, gap: 5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 28 }}>
            {bars.map((bar, i) => {
              const active = bars.length <= 1 ? progress > 0 : i / (bars.length - 1) <= progress;
              return (
                <View
                  key={`${i}-${bar}`}
                  style={{
                    flex: 1,
                    minWidth: 2,
                    height: Math.max(4, 24 * Math.max(0.04, Math.min(1, bar))),
                    borderRadius: 2,
                    backgroundColor: active ? colors.accent : colors.border,
                  }}
                />
              );
            })}
          </View>
          <View
            style={{
              height: 3,
              borderRadius: 2,
              backgroundColor: colors.border,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                width: `${Math.round(progress * 100)}%`,
                height: 3,
                backgroundColor: colors.accent,
              }}
            />
          </View>
        </View>
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
          {formatVoiceDuration(durationMs)}
        </Text>
      </View>
      {voice.transcript.status === 'pending' ? (
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontStyle: 'italic' }}>Transcribing…</Text>
      ) : voice.transcript.status === 'failed' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
          <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
            {retrying ? 'Retrying…' : 'Transcription failed'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry transcription"
            accessibilityState={{ disabled: retrying }}
            disabled={retrying}
            onPress={() => void retryTranscript()}
            hitSlop={8}
            style={{ minHeight: 28, justifyContent: 'center', opacity: retrying ? 0.6 : 1 }}
          >
            <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>Retry</Text>
          </Pressable>
          {retryError ? <Text style={{ color: colors.danger, fontSize: font.xs }}>Failed</Text> : null}
        </View>
      ) : voice.transcript.text?.trim() ? (
        <Text style={{ color: colors.textSecondary, fontSize: font.sm, lineHeight: 19 }}>{voice.transcript.text}</Text>
      ) : null}
    </View>
  );
}
