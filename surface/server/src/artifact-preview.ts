import { basename } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { firstHeader } from './artifact-route-utils.js';
import { DomainError } from './events.js';
import { sanitizeFilename } from './safe-filename.js';
import { getObjectBytes } from './s3.js';
import type { ArtifactServePlan } from './session-runs.js';

export type ArtifactPreviewRenderer = 'html-app' | 'react-jsx';

export async function artifactPreviewBytes(plan: ArtifactServePlan): Promise<Buffer> {
  if (plan.kind === 'redirect') {
    if (plan.s3Key) {
      return getObjectBytes(plan.s3Key);
    }
    const response = await fetch(plan.url);
    if (!response.ok) {
      throw new DomainError(502, 'artifact_preview_fetch_failed', 'failed to fetch artifact preview bytes');
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new DomainError(500, 'artifact_preview_unsupported_plan', 'unsupported artifact preview serve plan');
}

export function resolveArtifactPreviewRenderer(
  path: string,
  mime: string | null,
  hint?: string,
): ArtifactPreviewRenderer {
  const normalizedHint = (hint ?? '').trim().toLowerCase();
  if (normalizedHint === 'react-jsx') return 'react-jsx';
  if (normalizedHint === 'html-app') return 'html-app';
  if (/\.(jsx|tsx)$/i.test(path)) return 'react-jsx';
  if ((mime ?? '').toLowerCase() === 'text/html' || /\.html?$/i.test(path)) return 'html-app';
  return 'html-app';
}

export function isTopLevelDocumentNavigation(req: FastifyRequest): boolean {
  const dest = firstHeader(req.headers['sec-fetch-dest'])?.toLowerCase();
  const mode = firstHeader(req.headers['sec-fetch-mode'])?.toLowerCase();
  return dest === 'document' && mode === 'navigate';
}

export function sendArtifactPreview(
  reply: FastifyReply,
  params: {
    bytes: Buffer;
    path: string;
    mime: string | null;
    rendererHint?: string;
    headers?: Record<string, string>;
  },
): FastifyReply {
  const renderer = resolveArtifactPreviewRenderer(params.path, params.mime, params.rendererHint);
  const filename = basename(params.path) || 'artifact';
  for (const [name, value] of Object.entries(params.headers ?? {})) {
    reply.header(name, value);
  }
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Disposition', `inline; filename="${sanitizeFilename(filename)}"`);
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://esm.sh https://cdn.tailwindcss.com",
      "style-src 'unsafe-inline' https://cdn.tailwindcss.com",
      'img-src data: blob: https:',
      'font-src data: https:',
      'connect-src https:',
      "frame-ancestors 'self'",
    ].join('; '),
  );
  reply.header('Content-Type', 'text/html; charset=utf-8');
  if (renderer === 'react-jsx') {
    return reply.send(reactJsxPreviewDocument(params.bytes.toString('utf8'), filename));
  }
  return reply.send(params.bytes);
}

function reactJsxPreviewDocument(source: string, filename: string): string {
  const sourceJson = JSON.stringify(source);
  const titleJson = JSON.stringify(filename);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(filename)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <pre id="artifact-error" style="display:none; white-space:pre-wrap; padding:16px; color:#991b1b;"></pre>
  <script>
    const source = ${sourceJson};
    const title = ${titleJson};
    function showError(error) {
      const el = document.getElementById('artifact-error');
      el.style.display = 'block';
      el.textContent = String(error && error.stack ? error.stack : error);
    }
    function toRunnableJsx(input) {
      return input
        .replace(/^\\s*import\\s+.*?from\\s+['"].*?['"];?\\s*$/gm, '')
        .replace(/^\\s*import\\s+['"].*?['"];?\\s*$/gm, '')
        .replace(/export\\s+default\\s+function\\s+([A-Za-z0-9_$]+)/, 'function $1')
        .replace(/export\\s+default\\s+/, 'const App = ');
    }
    try {
      const cleaned = toRunnableJsx(source);
      // Force the classic JSX runtime: @babel/standalone now defaults the react
      // preset to the automatic runtime, which injects \`import { jsx } from
      // "react/jsx-runtime"\` - an import statement that throws inside new Function.
      // Classic emits React.createElement, which the scaffold supplies React for.
      const transformed = Babel.transform(cleaned, { presets: [['react', { runtime: 'classic' }]] }).code;
      const factory = new Function('React', transformed + '\\n; return typeof App !== "undefined" ? App : (typeof exports !== "undefined" && exports.default) || null;');
      const App = factory(React);
      if (!App) throw new Error('No default React component found in ' + title);
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
    } catch (error) {
      showError(error);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
