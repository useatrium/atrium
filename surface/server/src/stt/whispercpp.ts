import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadObject } from '../s3.js';
import { registerSttAdapter, type SttAdapter, type SttInput, type SttResult } from './adapter.js';

class WhisperCppAdapter implements SttAdapter {
  readonly name = 'whispercpp';

  async transcribe(input: SttInput): Promise<SttResult> {
    const modelPath = process.env.WHISPER_MODEL_PATH;
    if (!modelPath) {
      throw new Error('WHISPER_MODEL_PATH is required when STT_PROVIDER=whispercpp');
    }

    const dir = await mkdtemp(join(tmpdir(), 'atrium-stt-'));
    const sourcePath = join(dir, safeFilename(input.filename));
    const wavPath = join(dir, 'audio.wav');
    const outputBase = join(dir, 'transcript');
    try {
      await downloadObject(input.s3Key, sourcePath);
      await runProcess('ffmpeg', ['-y', '-i', sourcePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
      const whisper = await runProcess(process.env.WHISPER_BIN ?? 'whisper-cli', [
        '-m',
        modelPath,
        '-f',
        wavPath,
        '-otxt',
        '-oj',
        '-of',
        outputBase,
      ]);
      const text = await readFile(`${outputBase}.txt`, 'utf8').catch(() => whisper.stdout);
      const json = await readFile(`${outputBase}.json`, 'utf8').catch(() => '');
      const parsed = parseWhisperCppJson(json);
      return {
        text: parsed.text || text.trim(),
        ...(parsed.lang ? { lang: parsed.lang } : {}),
        ...(parsed.segments ? { segments: parsed.segments } : {}),
        model: `whispercpp:${basename(modelPath)}`,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export function registerWhisperCppAdapter(): void {
  registerSttAdapter(new WhisperCppAdapter());
}

function safeFilename(filename: string): string {
  const trimmed = basename(filename)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120);
  return trimmed || 'audio';
}

export function parseWhisperCppJson(json: string): Pick<SttResult, 'text' | 'lang' | 'segments'> {
  if (!json.trim()) return { text: '' };
  const parsed = JSON.parse(json) as {
    text?: unknown;
    language?: unknown;
    result?: { language?: unknown };
    params?: { language?: unknown };
    transcription?: Array<{
      text?: unknown;
      timestamps?: { from?: unknown; to?: unknown };
      offsets?: { from?: unknown; to?: unknown };
    }>;
  };
  const segments = Array.isArray(parsed.transcription)
    ? parsed.transcription
        .map((segment) => {
          const start = secondsFromWhisperTimestamp(segment.timestamps?.from, segment.offsets?.from);
          const end = secondsFromWhisperTimestamp(segment.timestamps?.to, segment.offsets?.to);
          const text = typeof segment.text === 'string' ? segment.text.trim() : '';
          return Number.isFinite(start) && Number.isFinite(end) && text ? { start, end, text } : null;
        })
        .filter((segment): segment is { start: number; end: number; text: string } => segment !== null)
    : undefined;
  const text =
    typeof parsed.text === 'string'
      ? parsed.text.trim()
      : (segments ?? [])
          .map((segment) => segment.text)
          .join(' ')
          .trim();
  const lang =
    typeof parsed.result?.language === 'string'
      ? parsed.result.language
      : typeof parsed.language === 'string'
        ? parsed.language
        : typeof parsed.params?.language === 'string' && parsed.params.language !== 'auto'
          ? parsed.params.language
          : undefined;
  return {
    text,
    ...(lang ? { lang } : {}),
    ...(segments && segments.length > 0 ? { segments } : {}),
  };
}

function secondsFromWhisperTimestamp(timestamp: unknown, offset: unknown): number {
  if (typeof offset === 'number' && Number.isFinite(offset)) return offset / 1000;
  if (typeof timestamp !== 'string') return Number.NaN;
  const match = /^(\d+):(\d+):(\d+)(?:[,.](\d+))?$/.exec(timestamp.trim());
  if (!match) return Number.NaN;
  const [, hours, minutes, seconds, fraction = '0'] = match;
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + millis / 1000;
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
      } else {
        reject(new Error(`${command} exited ${code}: ${err || out}`.slice(0, 2000)));
      }
    });
  });
}
