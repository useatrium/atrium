import type { FastifyReply } from 'fastify';
import type { MediaClassification } from './media-classifier.js';
import { canonicalizeSessionArtifactPath, InvalidArtifactPathError } from './artifact-path.js';

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function badArtifactPath(reply: FastifyReply, err: unknown) {
  if (err instanceof InvalidArtifactPathError) {
    return reply.code(400).send({ error: 'bad_query', message: err.message });
  }
  throw err;
}

export function canonicalizeRouteArtifactPath(
  reply: FastifyReply,
  input: string,
  ctx: { sessionId: string; channelId: string; readableChannelIds?: readonly string[] },
): string | null {
  try {
    return canonicalizeSessionArtifactPath(input, ctx);
  } catch (err) {
    badArtifactPath(reply, err);
    return null;
  }
}

export function normalizeMime(value: string | undefined): string {
  const mime = (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

export function mediaHeaders(classification: MediaClassification): Record<string, string> {
  return {
    'X-Detected-Mime': classification.detectedMime,
    'X-Media-Kind': classification.mediaKind,
    'X-Is-Text': classification.isText ? 'true' : 'false',
    ...(classification.textEncoding != null ? { 'X-Text-Encoding': classification.textEncoding } : {}),
  };
}

export function parseBaseSeq(value: string | undefined): number | null | false {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : false;
}
