import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceMeta } from '@atrium/surface-client';
import { api } from './api';
import { PauseIcon, PlayIcon } from './components/icons';

export function VoiceMessage({ voice }: { voice: VoiceMeta }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(voice.durationMs / 1000);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const muted = styles.getPropertyValue('--fg-muted').trim() || '#8f8f98';
    const accent = styles.getPropertyValue('--accent').trim() || '#4f46e5';
    const peaks = voice.waveform && voice.waveform.length > 0 ? voice.waveform : fallbackPeaks();
    const gap = 2;
    const barWidth = Math.max(2, Math.floor((width - gap * (peaks.length - 1)) / peaks.length));
    const usedWidth = peaks.length * barWidth + (peaks.length - 1) * gap;
    const left = Math.max(0, (width - usedWidth) / 2);
    const progressX = width * progress;

    peaks.forEach((peak, index) => {
      const x = left + index * (barWidth + gap);
      const barHeight = Math.max(4, Math.min(height, peak * height));
      const y = (height - barHeight) / 2;
      ctx.fillStyle = x + barWidth / 2 <= progressX ? accent : muted;
      roundRect(ctx, x, y, barWidth, barHeight, barWidth / 2);
      ctx.fill();
    });
  }, [progress, voice.waveform]);

  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const scrub = (clientX: number) => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || !audio || duration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const next = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
    audio.currentTime = next;
    setCurrentTime(next);
  };

  return (
    <div className="mt-0.5 max-w-md rounded-md border border-edge bg-surface-raised/45 px-2.5 py-2">
      <audio
        ref={audioRef}
        src={api.fileUrl(voice.fileId)}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const next = event.currentTarget.duration;
          if (Number.isFinite(next) && next > 0) setDuration(next);
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
        className="hidden"
      >
        <track kind="captions" />
      </audio>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          title={playing ? 'Pause voice message' : 'Play voice message'}
          aria-label={playing ? 'Pause voice message' : 'Play voice message'}
          className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-overlay text-fg-secondary hover:bg-edge-strong hover:text-fg"
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          onClick={(event) => scrub(event.clientX)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            scrub(event.clientX);
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1) scrub(event.clientX);
          }}
          aria-label="Scrub voice message"
          className="min-w-32 flex-1 cursor-pointer rounded-sm focus:outline-none focus:ring-1 focus:ring-edge-focus"
        >
          <canvas ref={canvasRef} className="block h-8 w-full" />
        </button>
        <span className="w-20 shrink-0 text-right text-2xs tabular-nums text-fg-muted">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
      <Transcript transcript={voice.transcript} fileId={voice.fileId} />
    </div>
  );
}

function Transcript({
  transcript,
  fileId,
}: {
  transcript: VoiceMeta['transcript'];
  fileId: string;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    if (transcript.status !== 'failed') {
      setRetrying(false);
      setRetryError(null);
    }
  }, [transcript.status]);

  if (transcript.status === 'pending') {
    return (
      <div className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
        <span className="h-1.5 w-12 animate-pulse rounded-full bg-surface-overlay" />
        <span>Transcribing…</span>
      </div>
    );
  }
  if (transcript.status === 'failed') {
    const retry = async () => {
      if (retrying) return;
      setRetrying(true);
      setRetryError(null);
      try {
        await api.retryTranscript(fileId);
      } catch {
        setRetrying(false);
        setRetryError("Couldn't retry transcription.");
      }
    };

    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
        <span>Transcription failed</span>
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          className="rounded-md border border-edge-strong px-2 py-0.5 text-2xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-default disabled:border-edge disabled:text-fg-faint"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
        {retryError && <span className="text-2xs text-danger-text">{retryError}</span>}
      </div>
    );
  }
  const text = transcript.text?.trim() ?? '';
  if (!text) return <div className="mt-1.5 text-xs text-fg-muted">No speech detected</div>;
  return (
    <div className="mt-1.5 select-text whitespace-pre-wrap text-sm leading-relaxed text-fg-body">
      {text}
    </div>
  );
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

function fallbackPeaks(): number[] {
  return Array.from({ length: 48 }, (_, index) => 0.12 + (index % 4) * 0.04);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
