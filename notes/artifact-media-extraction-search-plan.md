# Artifact media, extraction, and search plan

Status: scoped from current `master` on 2026-06-25. This supersedes stale
implementation assumptions in `artifact-file-types-design.md` while keeping that
document as design lineage.

## Current state

Storage is binary-safe, but product behavior is not media-aware:

- `cas_blobs` stores `mime`, `size_bytes`, and `s3_key`.
- Merge behavior has a MIME-derived `merge_class`, but there is no independent
  render/extract type.
- MIME is producer supplied and not consistently sniffed server-side.
- `FilesSurface` unconditionally calls `response.text()` and offers text-edit
  behavior around ledger content.
- Search indexes session text, not artifact content or derived text.

## Goals

1. Never corrupt or misrender binary files.
2. Classify media at byte ingress.
3. Extract cheap text projections for search and agent discovery.
4. Add artifact content search with ACL filtering.
5. Build a reusable media preview component for files, artifacts, and
   attachments.

Keep `merge_class` separate. It answers "how do conflicts merge?" `media_kind`
answers "how do we preview/extract/read this?"

## Phase 0: media model and classification

Add a server-side classifier at all byte ingress paths:

- upload auto-land;
- buffered artifact capture;
- streaming artifact capture;
- human writeback/upload bytes;
- future app publish validation reads.

Likely files:

- `surface/server/src/media-classification.ts`
- `surface/server/src/artifact-ledger.ts`
- `surface/server/src/artifact-writeback.ts`
- `surface/server/src/app.ts`
- migration after `047_agent_profiles.sql`

Suggested CAS fields:

- `detected_mime`
- `media_kind`
- `is_text`
- `text_encoding`
- `classification_meta`

Classification order:

1. magic bytes;
2. extension/path;
3. producer MIME as hint.

Do not trust upload `contentHash` for cross-object extraction/search dedupe until
the server verifies it.

## Phase 1: binary safety

Fix the known corruption paths before richer preview/search:

- `/api/sessions/:id/files/content` and artifact by-path routes expose MIME,
  media kind, `is_text`, seq, canonical path, and size.
- `FilesSurface` stops unconditional `response.text()`.
- Non-text rows render preview/download metadata and disable text edit.
- Writeback rejects non-text text edits unless the caller uses a byte upload path.
- Conflict rendering never decodes immutable binary sides as UTF-8.

Tests should include an image or random binary through files/content and verify
the UI does not decode or allow save.

## Phase 2: derived text extraction

Create a generalized extraction worker modeled on the existing STT worker:

- `derived_text` keyed by `cas_blobs.sha256`;
- status, attempts, error, model/provider, language, metadata;
- `FOR UPDATE SKIP LOCKED` worker loop;
- extractor registry by `media_kind`.

Eager v1 extractors:

- text/code identity;
- markdown/plain text;
- JSON/TOML/YAML flatten;
- CSV flatten;
- PDF text layer if dependency cost is acceptable.

Lazy later:

- OCR;
- vision captions;
- audio/video transcription beyond current voice path;
- keyframes.

Security:

- derived text can expose secrets from artifacts;
- index redacted text by default;
- raw extracted text access should remain deliberate and ACL-checked.

## Phase 3: artifact content search

Extend search to include derived artifact text without stuffing it into
`session_records`.

Likely implementation:

- `artifact_search_documents` or `derived_text.tsv` GIN index;
- ACL filter using artifact scope resolver;
- results include source kind, path, media kind, artifact id, seq, excerpt, and
  scope metadata.

Search result UX should distinguish transcript hits from artifact hits.

## Phase 4: reusable MediaPreview

Add one preview seam used by:

- `FilesSurface`
- `ArtifactsSurface`
- chat attachments in `MessageRow`
- mobile surfaces later

V1 previews:

- text/code/markdown: safe text renderer;
- JSON/CSV: structured/table view;
- image: existing thumbnail/full view;
- PDF: metadata/download first, pdf.js later if the dependency is acceptable;
- audio: player and transcript when available;
- opaque: metadata/download.

## Tests

Server:

- MIME spoofing and magic-byte classification;
- each byte ingress classifies consistently;
- binary content route exposes metadata and does not imply text;
- text edit path still supports base-seq conflict behavior;
- non-text edit is rejected;
- derived text queue dedupes by sha;
- extraction retries/failure state;
- search returns artifact hits only when user has access.

Web:

- `FilesSurface` text vs binary behavior;
- `MediaPreview` image/text/opaque cases;
- attachment preview parity;
- search result rendering for artifact hits.

## Risks

- Classification stored only on `cas_blobs` can lose path-extension nuance for
  identical bytes with different filenames. Acceptable for v1; keep
  `classification_meta` extensible.
- Large files need strict caps and lazy extraction to avoid worker stalls.
- Search/extraction dedupe must not trust client-supplied hashes.
- Rich previews may require an authenticated byte proxy rather than presigned
  S3 redirects so headers and ACL remain under Atrium control.

