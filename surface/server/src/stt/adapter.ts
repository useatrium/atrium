// Speech-to-text adapter seam. Selected by env STT_PROVIDER so the model is a
// pluggable, swappable detail (CPU now, GPU later) — see notes/voice-support.md.
//
// Foundation ships the interface + a `noop` adapter (returns empty text) so the
// pipeline and CI are exercisable without downloading a model. Lane A adds the
// real `whispercpp` adapter (child_process, model via WHISPER_MODEL_PATH) and
// may register further providers here.

export interface SttInput {
  /** S3/MinIO object key for the audio file (see files.s3_key). */
  s3Key: string;
  contentType: string;
  filename: string;
}

export interface SttResult {
  text: string;
  lang?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  /** Identifier of the model/provider that produced this result. */
  model: string;
}

export interface SttAdapter {
  readonly name: string;
  transcribe(input: SttInput): Promise<SttResult>;
}

/** No-op adapter: marks the job done with empty text. Default + CI/test fallback
 * so the transcription pipeline runs without any model present. */
export const noopAdapter: SttAdapter = {
  name: 'noop',
  async transcribe(): Promise<SttResult> {
    return { text: '', model: 'noop' };
  },
};

/** Provider registry. Lane A registers real adapters (e.g. 'whispercpp') here. */
const registry: Record<string, SttAdapter> = {
  noop: noopAdapter,
};

export function registerSttAdapter(adapter: SttAdapter): void {
  registry[adapter.name] = adapter;
}

/** Resolve the configured adapter; falls back to `noop` if unknown/unset. */
export function getSttAdapter(provider = process.env.STT_PROVIDER ?? 'noop'): SttAdapter {
  return registry[provider] ?? noopAdapter;
}
