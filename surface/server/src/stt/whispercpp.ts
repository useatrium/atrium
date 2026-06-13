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
      await runProcess('ffmpeg', [
        '-y',
        '-i',
        sourcePath,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wavPath,
      ]);
      const whisper = await runProcess(process.env.WHISPER_BIN ?? 'whisper-cli', [
        '-m',
        modelPath,
        '-f',
        wavPath,
        '-otxt',
        '-of',
        outputBase,
      ]);
      const text = await readFile(`${outputBase}.txt`, 'utf8').catch(() => whisper.stdout);
      return {
        text: text.trim(),
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
  const trimmed = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return trimmed || 'audio';
}

function runProcess(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
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
