export type MediaKind =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'archive'
  | 'json'
  | 'document'
  | 'binary';

export interface MediaClassification {
  detectedMime: string;
  mediaKind: MediaKind;
  isText: boolean;
  textEncoding: string | null;
  meta: Record<string, unknown>;
}

const TEXT_EXTENSIONS = new Set([
  'css',
  'csv',
  'js',
  'jsx',
  'json',
  'jsonl',
  'log',
  'md',
  'mdx',
  'mjs',
  'py',
  'rs',
  'sql',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);

export function classifyMedia(
  bytes: Buffer | Uint8Array,
  options: { declaredMime?: string | null; filename?: string | null } = {},
): MediaClassification {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const declaredMime = normalizeMime(options.declaredMime);
  const magicMime = sniffMagicMime(buffer);
  const extension = extensionOf(options.filename);
  const declaredKind = kindForMime(declaredMime);
  const textProbe = probeUtf8Text(buffer);
  const extensionLooksText = extension != null && TEXT_EXTENSIONS.has(extension);
  const mimeLooksText = mimeIsTextual(declaredMime);
  const isText = magicMime == null && textProbe.valid && (mimeLooksText || extensionLooksText || declaredMime === 'application/octet-stream');
  const detectedMime = magicMime ?? (isText && declaredMime === 'application/octet-stream' ? 'text/plain' : declaredMime);
  const mediaKind = isText ? kindForTextMime(detectedMime) : kindForMime(detectedMime) ?? declaredKind ?? 'binary';

  return {
    detectedMime,
    mediaKind,
    isText,
    textEncoding: isText ? textProbe.encoding : null,
    meta: {
      declared_mime: declaredMime,
      ...(magicMime != null ? { magic_mime: magicMime } : {}),
      ...(extension != null ? { extension } : {}),
      text_probe: textProbe.reason,
    },
  };
}

export function classifyMediaFromMime(mime: string): MediaClassification {
  const normalized = normalizeMime(mime);
  const textual = mimeIsTextual(normalized);
  return {
    detectedMime: normalized,
    mediaKind: textual ? kindForTextMime(normalized) : (kindForMime(normalized) ?? 'binary'),
    isText: textual,
    textEncoding: textual ? 'utf-8' : null,
    meta: { declared_mime: normalized, source: 'mime_only' },
  };
}

function normalizeMime(value: string | null | undefined): string {
  const mime = (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

function sniffMagicMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'application/zip';
  }
  return null;
}

function probeUtf8Text(buffer: Buffer): { valid: boolean; encoding: string | null; reason: string } {
  if (buffer.includes(0)) return { valid: false, encoding: null, reason: 'nul_byte' };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { valid: false, encoding: null, reason: 'invalid_utf8' };
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control += 1;
  }
  if (sample.length > 0 && control / sample.length > 0.01) {
    return { valid: false, encoding: null, reason: 'control_bytes' };
  }
  const ascii = buffer.every((byte) => byte < 0x80);
  return { valid: true, encoding: ascii ? 'ascii' : 'utf-8', reason: ascii ? 'ascii' : 'utf8' };
}

function mimeIsTextual(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml') ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript'
  );
}

function kindForTextMime(mime: string): MediaKind {
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json';
  return 'text';
}

function kindForMime(mime: string): MediaKind | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/zip' || mime === 'application/x-tar' || mime === 'application/gzip') return 'archive';
  if (mime === 'application/msword' || mime.includes('officedocument')) return 'document';
  if (mimeIsTextual(mime)) return kindForTextMime(mime);
  return null;
}

function extensionOf(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}
