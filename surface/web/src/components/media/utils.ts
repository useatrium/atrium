import type { MediaKind, PreviewFile } from './types';

const IMAGE_MIME = /^image\//;
const VIDEO_MIME = /^video\//;
const AUDIO_MIME = /^audio\//;
const TEXT_MIME = /^text\//;

const CODE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'java',
  'js',
  'jsx',
  'kt',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'tsx',
  'ts',
]);

const DATA_EXTENSIONS = new Set(['csv', 'ipynb', 'json', 'jsonl', 'toml', 'tsv', 'yaml', 'yml']);
const APP_EXTENSIONS = new Set(['html', 'htm', 'jsx', 'tsx']);
const WORD_EXTENSIONS = new Set(['doc', 'docx', 'docm', 'dotx', 'dotm']);
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'ods']);
const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'pptm', 'pps', 'ppsx']);

export type OfficeFileKind = 'word' | 'spreadsheet' | 'presentation';

export function fileExtension(name: string) {
  const clean = name.split('?')[0]?.split('#')[0] ?? name;
  const idx = clean.lastIndexOf('.');
  return idx >= 0 ? clean.slice(idx + 1).toLowerCase() : '';
}

export function effectiveMediaKind(file: PreviewFile): MediaKind {
  if (file.mediaKind !== 'opaque') return file.mediaKind;
  const mime = file.mime.toLowerCase();
  const ext = fileExtension(file.name);
  if (IMAGE_MIME.test(mime)) return 'image';
  if (VIDEO_MIME.test(mime)) return 'video';
  if (AUDIO_MIME.test(mime)) return 'audio';
  if (mime === 'application/pdf') return 'document';
  if (isOfficeFile(file)) return 'document';
  if (mime.includes('csv') || DATA_EXTENSIONS.has(ext)) return 'data';
  if (mime.includes('json') || mime.includes('yaml')) return 'data';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (TEXT_MIME.test(mime) || ext === 'md' || ext === 'markdown' || ext === 'txt') return 'text';
  return 'opaque';
}

export function isMarkdownFile(file: PreviewFile) {
  const mime = file.mime.toLowerCase();
  const ext = fileExtension(file.name);
  return mime === 'text/markdown' || mime === 'text/x-markdown' || ext === 'md' || ext === 'markdown';
}

export function isPdfFile(file: PreviewFile) {
  return file.mime.toLowerCase() === 'application/pdf' || fileExtension(file.name) === 'pdf';
}

// App preview: HTML and JSX/TSX artifacts render through the sandboxed iframe endpoint.
export function isAppFile(file: PreviewFile) {
  const mime = file.mime.toLowerCase();
  const ext = fileExtension(file.name);
  return mime === 'text/html' || mime === 'application/xhtml+xml' || APP_EXTENSIONS.has(ext);
}

export function officeFileKind(file: PreviewFile): OfficeFileKind | null {
  const ext = fileExtension(file.name);
  const mime = file.mime.toLowerCase();

  if (
    WORD_EXTENSIONS.has(ext) ||
    mime === 'application/msword' ||
    mime.includes('wordprocessingml') ||
    mime.includes('ms-word')
  ) {
    return 'word';
  }

  if (
    SPREADSHEET_EXTENSIONS.has(ext) ||
    (ext === 'csv' && mime === 'application/vnd.ms-excel') ||
    mime === 'application/vnd.ms-excel' ||
    mime.includes('spreadsheetml') ||
    mime.includes('ms-excel')
  ) {
    return 'spreadsheet';
  }

  if (
    PRESENTATION_EXTENSIONS.has(ext) ||
    mime === 'application/vnd.ms-powerpoint' ||
    mime.includes('presentationml') ||
    mime.includes('ms-powerpoint')
  ) {
    return 'presentation';
  }

  return null;
}

export function isOfficeFile(file: PreviewFile) {
  return officeFileKind(file) !== null;
}

export function isDocxFile(file: PreviewFile) {
  const ext = fileExtension(file.name);
  const mime = file.mime.toLowerCase();
  return ext === 'docx' || ext === 'docm' || ext === 'dotx' || ext === 'dotm' || mime.includes('wordprocessingml');
}

export function isNotebookFile(file: PreviewFile) {
  return fileExtension(file.name) === 'ipynb' || file.mime.toLowerCase().includes('ipynb');
}

export function isCsvFile(file: PreviewFile) {
  const ext = fileExtension(file.name);
  const mime = file.mime.toLowerCase();
  return ext === 'csv' || ext === 'tsv' || mime.includes('csv') || mime.includes('tab-separated-values');
}

export function languageForFile(file: PreviewFile) {
  const ext = fileExtension(file.name);
  if (ext === 'tsx') return 'tsx';
  if (ext === 'jsx') return 'jsx';
  if (ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'js') return 'javascript';
  if (ext === 'ts') return 'typescript';
  if (ext === 'py') return 'python';
  if (ext === 'rb') return 'ruby';
  if (ext === 'rs') return 'rust';
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'bash';
  if (ext === 'yml' || ext === 'yaml') return 'yaml';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'text';
  if (ext) return ext;
  const mime = file.mime.toLowerCase();
  if (mime.includes('json')) return 'json';
  if (mime.includes('xml')) return 'xml';
  if (mime.includes('html')) return 'html';
  if (mime.includes('css')) return 'css';
  return 'text';
}

export function previewUrl(file: PreviewFile) {
  return file.textUrl ?? file.contentUrl;
}

export function formatBytes(bytes?: number) {
  if (bytes == null || !Number.isFinite(bytes)) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

export function formatDateTime(value?: string) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export async function fetchText(file: PreviewFile, signal?: AbortSignal) {
  const res = await fetch(previewUrl(file), { signal });
  if (!res.ok) throw new Error(`Failed to load ${file.name}: ${res.status}`);
  return res.text();
}

export function kindLabel(kind: MediaKind) {
  return kind[0]?.toUpperCase() + kind.slice(1);
}
