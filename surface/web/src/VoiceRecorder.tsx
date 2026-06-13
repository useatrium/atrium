import { useEffect, useMemo, useRef, useState } from 'react';
import { MicIcon, PauseIcon, PlayIcon, RefreshCwIcon, SendIcon, SquareIcon, XIcon } from './components/icons';

export interface RecordedVoice {
  blob: Blob;
  durationMs: number;
  waveform: number[];
  filename: string;
}

type RecorderPhase = 'idle' | 'recording' | 'preview';

const TARGET_PEAKS = 48;
const SAMPLE_INTERVAL_MS = 80;

export function VoiceRecorder({
  disabled,
  onSend,
  onActiveChange,
}: {
  disabled?: boolean;
  onSend: (voice: RecordedVoice) => Promise<void>;
  onActiveChange?: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [livePeaks, setLivePeaks] = useState<number[]>([]);
  const [preview, setPreview] = useState<RecordedVoice | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const peaksRef = useRef<number[]>([]);
  const startedAtRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cancelledRef = useRef(false);

  const visiblePeaks = useMemo(() => {
    if (phase === 'recording') return livePeaks.slice(-24);
    return preview?.waveform ?? [];
  }, [livePeaks, phase, preview?.waveform]);

  useEffect(() => {
    onActiveChange?.(phase !== 'idle');
  }, [onActiveChange, phase]);

  const stopTimers = () => {
    if (analyserTimerRef.current != null) {
      window.clearInterval(analyserTimerRef.current);
      analyserTimerRef.current = null;
    }
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  };

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    mediaRecorderRef.current = null;
  };

  const startAnalyser = (stream: MediaStream) => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    audioContextRef.current = audioContext;
    const data = new Uint8Array(analyser.fftSize);
    analyserTimerRef.current = window.setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const value of data) {
        peak = Math.max(peak, Math.abs(value - 128) / 128);
      }
      const normalized = Math.min(1, peak * 2.4);
      peaksRef.current.push(normalized);
      setLivePeaks((prev) => [...prev.slice(-23), normalized]);
    }, SAMPLE_INTERVAL_MS);
  };

  useEffect(() => {
    return () => {
      // Unmount mid-recording: mark the in-flight take cancelled so onstop takes
      // the cleanup branch (no dangling object URL) and release mic + audio graph.
      cancelledRef.current = true;
      stopTimers();
      stopStream();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewUrl]);

  const resetPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreview(null);
    setPreviewUrl(null);
    setPreviewPlaying(false);
  };

  const start = async () => {
    if (disabled || sending || phase !== 'idle') return;
    setError(null);
    resetPreview();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mimeType = chooseMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      peaksRef.current = [];
      startedAtRef.current = performance.now();
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      cancelledRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (cancelledRef.current) {
          stopTimers();
          stopStream();
          setElapsedMs(0);
          setLivePeaks([]);
          setPhase('idle');
          return;
        }
        const durationMs = Math.max(1, Math.round(performance.now() - startedAtRef.current));
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        const nextPreview: RecordedVoice = {
          blob,
          durationMs,
          waveform: reducePeaks(peaksRef.current, TARGET_PEAKS),
          filename: `voice-${Date.now()}.${extensionForContentType(type)}`,
        };
        const url = URL.createObjectURL(blob);
        stopTimers();
        stopStream();
        setElapsedMs(durationMs);
        setLivePeaks([]);
        setPreview(nextPreview);
        setPreviewUrl(url);
        setPhase('preview');
      };

      startAnalyser(stream);
      recorder.start(250);
      setElapsedMs(0);
      setLivePeaks([]);
      setPhase('recording');
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedMs(Math.round(performance.now() - startedAtRef.current));
      }, 200);
    } catch (err) {
      console.warn('voice recorder failed to start', err);
      stopTimers();
      stopStream();
      setPhase('idle');
      setError('Microphone access was blocked.');
    }
  };

  const stop = () => {
    if (phase !== 'recording') return;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  };

  const cancel = () => {
    if (phase === 'recording') {
      const recorder = mediaRecorderRef.current;
      cancelledRef.current = true;
      recorder?.stream.getTracks().forEach((track) => track.stop());
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    }
    stopTimers();
    stopStream();
    resetPreview();
    setElapsedMs(0);
    setLivePeaks([]);
    setPhase('idle');
  };

  const send = async () => {
    if (!preview || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(preview);
      resetPreview();
      setElapsedMs(0);
      setPhase('idle');
    } catch (err) {
      console.warn('voice message send failed', err);
      setError("Couldn't send the voice message.");
    } finally {
      setSending(false);
    }
  };

  const togglePreview = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  };

  if (phase === 'recording') {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          onClick={stop}
          title="Stop recording"
          aria-label="Stop recording"
          className="rounded-md bg-danger-tint px-2 py-1 text-danger-text hover:bg-danger-surface/70"
        >
          <SquareIcon />
        </button>
        <span className="w-12 text-xs tabular-nums text-fg-secondary">{formatDuration(elapsedMs)}</span>
        <MiniWaveform peaks={visiblePeaks} active />
        <button
          onClick={cancel}
          title="Cancel recording"
          aria-label="Cancel recording"
          className="rounded-md px-1 py-1 text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
        >
          <XIcon />
        </button>
      </div>
    );
  }

  if (phase === 'preview' && preview && previewUrl) {
    return (
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <audio
          ref={audioRef}
          src={previewUrl}
          onPlay={() => setPreviewPlaying(true)}
          onPause={() => setPreviewPlaying(false)}
          onEnded={() => setPreviewPlaying(false)}
          className="hidden"
        />
        <button
          onClick={togglePreview}
          title={previewPlaying ? 'Pause preview' : 'Play preview'}
          aria-label={previewPlaying ? 'Pause preview' : 'Play preview'}
          className="rounded-md px-2 py-1 text-fg-secondary hover:bg-surface-overlay hover:text-fg-body"
        >
          {previewPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="w-12 text-xs tabular-nums text-fg-secondary">
          {formatDuration(preview.durationMs)}
        </span>
        <MiniWaveform peaks={visiblePeaks} />
        <button
          onClick={cancel}
          disabled={sending}
          title="Re-record"
          aria-label="Re-record"
          className="rounded-md px-1 py-1 text-fg-muted hover:bg-surface-overlay hover:text-fg-body disabled:opacity-50"
        >
          <RefreshCwIcon />
        </button>
        <button
          onClick={cancel}
          disabled={sending}
          title="Cancel voice message"
          aria-label="Cancel voice message"
          className="rounded-md px-1 py-1 text-fg-muted hover:bg-surface-overlay hover:text-fg-body disabled:opacity-50"
        >
          <XIcon />
        </button>
        <button
          onClick={() => void send()}
          disabled={sending}
          title="Send voice message"
          aria-label="Send voice message"
          className="rounded-md bg-accent px-2 py-1 text-on-accent hover:bg-accent-hover disabled:cursor-default disabled:bg-surface-overlay disabled:text-fg-muted"
        >
          {sending ? <span className="text-xs">Sending…</span> : <SendIcon />}
        </button>
        {error && <span className="basis-full text-3xs text-danger-text">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => void start()}
        disabled={disabled || sending}
        title="Record a voice message"
        aria-label="Record a voice message"
        className="rounded-md px-1 py-1 text-sm text-fg-muted hover:bg-surface-overlay hover:text-fg-body disabled:cursor-default disabled:text-fg-faint"
      >
        <MicIcon />
      </button>
      {error && <span className="text-3xs text-danger-text">{error}</span>}
    </div>
  );
}

function chooseMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('ogg')) return 'ogg';
  return 'webm';
}

function reducePeaks(peaks: number[], buckets: number): number[] {
  if (peaks.length === 0) return Array.from({ length: buckets }, () => 0.08);
  return Array.from({ length: buckets }, (_, bucket) => {
    const start = Math.floor((bucket * peaks.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * peaks.length) / buckets));
    let max = 0;
    for (let i = start; i < end; i++) max = Math.max(max, peaks[i] ?? 0);
    return Math.max(0.04, Math.min(1, max));
  });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function MiniWaveform({ peaks, active }: { peaks: number[]; active?: boolean }) {
  const bars = peaks.length > 0 ? peaks : Array.from({ length: 24 }, () => 0.08);
  return (
    <div className="flex h-7 min-w-24 flex-1 items-center gap-0.5 overflow-hidden rounded-md border border-edge bg-surface px-1">
      {bars.map((peak, index) => (
        <span
          key={`${index}-${peak.toFixed(2)}`}
          className={`w-1 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-fg-muted/60'}`}
          style={{ height: `${Math.max(3, Math.round(peak * 24))}px` }}
        />
      ))}
    </div>
  );
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
