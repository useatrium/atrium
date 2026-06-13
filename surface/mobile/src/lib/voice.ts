export interface VoiceSendMeta {
  durationMs: number;
  waveform?: number[];
}

export function formatVoiceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function normalizeMetering(metering: number | undefined): number | null {
  if (metering == null || !Number.isFinite(metering)) return null;
  // expo-audio reports dBFS where 0 is loud and about -60 is near silence.
  return Math.max(0.04, Math.min(1, (metering + 60) / 60));
}

export function downsamplePeaks(samples: number[], buckets = 48): number[] | undefined {
  if (samples.length === 0) return undefined;
  const size = Math.ceil(samples.length / buckets);
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += size) {
    peaks.push(Math.max(...samples.slice(i, i + size)));
  }
  return peaks.slice(0, buckets).map((v) => Math.max(0.04, Math.min(1, Number(v.toFixed(3)))));
}
