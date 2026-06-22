# Atrium File-Types UX — Design Exploration

> Spun out of [`macro-borrow-plan.md`](./macro-borrow-plan.md) §6.3 (2026-06-22). Goal: a real design for how Atrium handles non-text file types — **agent-UX-first, then human-UX**. Grounded in a code-mapping pass of the current artifact/file/render/extract paths (file refs inline). Companion concepts: [[agent-data-architecture]] (merge-class, CAS ledger), the §6.1 code-mode/typed-layer principle.

---

## 1. The gap

Atrium can already *store* any bytes — two byte stores, the **uploads** table (`files`, `006_files.sql`) and the **artifact CAS ledger** (`artifacts`/`artifact_versions`/`cas_blobs`, migs 031–038), both binary-safe end to end. What it can't do is **see inside** non-text files or **show** them:

- **Agents are blind to binary content.** They get true raw bytes (`/api/sessions/:id/artifacts/by-path`, internal `…/raw`), but `/atrium` is text-metadata only and **nothing indexes file content** — a PDF spec or a screenshot a human dropped in is invisible to search (`session-search.ts` indexes only `session_records.text`) and to memory. An agent can't grep a PDF or "see" a screenshot.
- **Humans get image-only previews.** The gallery (`ArtifactsSurface.tsx`) renders `image/*` as a thumbnail and **everything else as a grey type-label tile**; chat uploads (`MessageRow.tsx`) preview images inline and everything else as a download chip. No PDF/markdown/code/CSV/notebook rendering exists (no preview libs are even installed). `FilesSurface.tsx` blindly `response.text()`s every file — **a binary renders as mojibake and a save corrupts it** (a real bug today).
- **No version diffing for blobs.** Diffs today are synthesized from agent edit tool-calls (`fileChangeView.tsx`, plain `+/-` lines), not from comparing CAS versions. The gallery shows a `v{N}` badge but there's no way to view or compare prior versions — and no image/structured/notebook diff anywhere.
- **The only "type system" is `merge_class`** (`mergeClassForMime`, `session-runs.ts:2606`): `text/* | */markdown | application/json` → `mergeable-doc`, else `immutable-data`. MIME-prefix based, and **MIME is trusted from the producer, never sniffed server-side.** There is no binary-vs-text flag.

So: storage is solved; **comprehension, presentation, and discoverability of non-text types are not.**

---

## 2. Principles

1. **Agent-UX-first.** The win that matters most is making binary content *findable and readable* by agents (search + memory + `atrium cat`), because that unblocks real work ("read the design PDF", "what's in that screenshot"). Human preview is the close second.
2. **Derive, don't demand** (the §6.1 principle, applied to bytes). The system extracts text/structure *from* the file; the agent/human never has to pre-annotate it.
3. **Reuse the byte plumbing.** CAS dedup, binary-safe serve, merge-class conflict gating, and the existing **STT extraction pipeline** are all load-bearing and correct — extend them, don't rebuild.
4. **Two orthogonal axes, kept separate.** `merge_class` (conflict behavior — load-bearing for write-back) stays as-is. Add a *separate* `media_kind` axis (render/extract behavior). Don't overload one enum with two jobs.
5. **Cost-aware extraction.** Cheap deterministic extractors run eagerly; LLM/OCR/vision extractors run lazily/opt-in. Dedup by content hash so identical bytes are never extracted twice.
6. **Unify uploads + artifacts.** A human-dropped PDF and an agent-produced PDF must get the *same* treatment (classify → extract → index → preview). Today `files` and `artifacts` diverge; the media-kind + derived-text + preview layer should span both.
7. **Don't dump bytes into context.** `atrium cat` on a 200-page PDF or a 50MB blob returns a head + size + how-to-page, not the whole thing. Typed results, not raw firehoses.

---

## 3. A small media-kind taxonomy

One new axis (`media_kind`) + a derived `is_text` boolean, set at capture/upload by **server-side sniffing** (magic bytes + extension + the producer MIME as a hint, in that order of trust). This fixes the "MIME is trusted blindly" gap.

| `media_kind` | examples | `merge_class` | extraction (derived text) | agent default read | human preview | version diff |
|---|---|---|---|---|---|---|
| `text-prose` | md, txt | mergeable-doc | identity (already text) + frontmatter (§6.1) | text | markdown render | line diff |
| `code` | .ts/.py/.rs/… | mergeable-doc | identity | text | syntax highlight | line diff (intra-line) |
| `structured` | json, yaml, csv, toml, ipynb | **immutable** (diff3-unsafe) | flatten to searchable text | text (pretty) | json tree / csv table / **ipynb cells** | **structured diff** (cell/row/key) |
| `document` | pdf, docx, pptx | immutable | text layer → OCR fallback | derived text (+`--raw` pages) | pdf.js / page render | text-layer diff (+page-render diff) |
| `image` | png, jpg, svg, webp | immutable | OCR + optional vision caption | **raw bytes to vision model** (multimodal), else caption | thumbnail + zoom | side-by-side + onion-skin + pixel diff |
| `audio` | wav, mp3, m4a | immutable | **transcription (reuse STT)** | transcript (+timestamps) | player + transcript | transcript diff |
| `video` | mp4, mov | immutable | audio-track STT + keyframe caption | transcript | player + transcript + keyframes | transcript diff |
| `opaque` | zip, bin, exe, … | immutable | none | metadata only | metadata + download | "changed: N→M bytes, sha X→Y" |

`merge_class` is unchanged for conflict purposes; `media_kind` drives rendering + extraction. The pair also fixes binary safety: `FilesSurface`/write-back branch on `is_text` instead of blindly decoding.

---

## 4. Server-side: the derived-text projection pipeline

**Reuse the STT pattern almost verbatim.** Today: `transcripts` queue (`024_voice_transcripts.sql`) + `SttWorker` (5s poll, `FOR UPDATE SKIP LOCKED`, concurrency 2, retries, boot re-sweep) + a pluggable `SttAdapter` registry (`stt/adapter.ts`, selected by `STT_PROVIDER`; `whispercpp` shells ffmpeg+whisper-cli) → writes `transcripts.text` → emits `voice.transcribed` over the WS hub. That is exactly the shape "S3 input → provider → stored derived text → event."

**Generalize it:**
- **New table `derived_text`** keyed by **`cas_blobs.sha256`** (so identical bytes are extracted exactly once, ever — free dedup, and it also covers uploads if they're CAS-keyed). Columns mirror `transcripts`: `sha256, kind (text|ocr|caption|transcript|flatten), text, lang, meta jsonb, model, status, attempts, error`. Store the derived text *itself* as a CAS blob too, so the agent can fetch it via the existing serve path.
- **An extraction worker** = the SttWorker shape with an **extractor registry keyed by `media_kind`**:
  - `document` → pdf text-layer (pdftotext/pdfjs); OCR fallback when no text layer.
  - `image` → OCR (tesseract) + optional vision caption (LLM).
  - `audio` → **the existing `SttAdapter` directly.**
  - `video` → demux audio → STT; keyframe → caption.
  - `structured` → flatten (csv→rows, json→key/value paths) for indexing.
  - `text-prose`/`code` → identity (no extraction; index the bytes directly).
- **Enqueue** on artifact capture (`session-runs.ts` capture path) and on upload (`/api/uploads`), keyed by sha so re-captures/identical uploads skip.
- **Output feeds search + memory** (§6).

**Cost tiering (principle 5):**
- **Eager** (cheap, deterministic, run on capture): text/code identity, structured flatten, PDF text-layer. These make most real content searchable immediately at ~zero marginal cost.
- **Lazy / opt-in** (LLM or heavy): OCR, vision caption, audio/video transcription. Triggered on first reference (an agent `atrium cat`s it, or a human opens it) or by an explicit "extract" action, gated by a per-workspace budget flag. Ties into the LLM-spend FinOps story in [[deployment-hosting-strategy]].
- **Escape hatch:** the agent already has a sandbox with tools — it can always run `pdftotext`/`jq`/`tesseract` itself. The pipeline is the *convenient, indexed, dedup'd* path, not the only one.

---

## 5. Agent UX per type — the multimodal fork

The crux. There are **two ways** an agent consumes a binary, and the right default differs by type:

1. **Derived text** — `atrium cat report.pdf` → extracted text + a typed header (`media_kind`, page count, "raw available", lang). Good for grep/reason; cheap on context.
2. **Raw bytes to a multimodal model** — for images (and layout-sensitive PDFs), modern Claude ingests the actual pixels as a content block. Handing the *real image* to the model beats an OCR string for "what's wrong in this screenshot."

**`atrium cat <path>` (the in-sandbox typed CLI from §6.1) picks smartly, with overrides:**
- `text-prose`/`code`/`structured` → bytes as text (structured pretty-printed).
- `image` → **the image itself as a model content block** when the harness/model is multimodal; else the caption/OCR text. `--text` forces derived text; `--raw` forces bytes.
- `document` (pdf) → derived text by default (PDFs are long); `--pages 3-5 --raw` returns rendered pages to a vision model for layout-sensitive cases.
- `audio`/`video` → transcript text with timestamps; raw bytes rarely useful to the model.
- **Guardrails:** large files return head + size + `--range` hint, never the whole blob; long derived text is paginated/summarized. The CLI returns *typed results* ("this is an image; caption=…; raw available"), not a byte firehose — directly the code-mode payoff (§6.1).
- **Discovery first:** `atrium ls` shows `media_kind`, size, and whether derived text exists, so the agent knows what it's dealing with *before* fetching (avoids blindly catting a 50MB binary).

Net agent-UX shift: from "raw bytes you can't introspect" → "typed, searchable, summarizable file objects the agent can choose how to consume."

---

## 6. Search & memory integration

- **Index the derived text** (+ path + `media_kind`) into the FTS index and the memory layer (borrow-plan items 1 & 4). This is what makes *"find the diagram about X"* and *"what did that PDF say"* work — today neither does.
- **NameSearch facets** (item 1's metadata axis): query by path/extension/`media_kind` ("pdfs in proj-x", "images touched this week").
- **Dedup for free:** derived text keyed by source sha means re-uploads and identical artifacts share one extraction and one index entry.

---

## 7. Human UX per type

**Preview matrix** (artifact card / gallery / `FilesSurface`), upgrading from today's image-only:
- `text-prose` → markdown render (+ raw toggle); `code` → syntax highlight (shiki/prism); `structured`: json tree / **csv table** / **ipynb rendered cells**; `document` → pdf.js embed w/ page nav; `image` → thumbnail (have it) + full view/zoom; `audio` → player + transcript (the transcript already exists for voice!); `video` → player + transcript + keyframes; `opaque` → metadata + download.

**Version history + diff** (currently absent for blobs — the gallery has a `v{N}` badge but no viewer):
- Build a version-history viewer, then per-type diff: line diff for text/code (upgrade `DiffView` with intra-line highlight); **cell/row/key diff** for ipynb/csv/json (raw-JSON diff is unusable for notebooks); text-layer (+optional page-render) diff for pdf; **side-by-side + onion-skin + pixel-diff** for images; transcript diff for audio/video; byte/sha delta for opaque.

**Correctness fix (do early):** `FilesSurface` must branch on `is_text`/`media_kind` — never `response.text()` a binary (mojibake), never offer text-edit on a non-text file (corruption). Same explicit binary guard on the write-back/conflict `toString('utf8')` paths.

---

## 8. Sequencing

Fast-follow on borrow-plan Phase A (search) + Phase C (memory). Each sub-phase ships independently:

- **F0 — correctness & classification (small).** Server-side MIME sniff at capture/upload; add `media_kind` + `is_text`; fix `FilesSurface` binary safety. Fixes a real corruption bug; unblocks everything else.
- **F1 — cheap derived text + index (biggest agent-UX win).** Generalize the STT worker into the extraction pipeline; eager cheap extractors (pdf-text-layer, csv/json flatten, text identity); index derived text into search + memory; `atrium ls`/`cat` return `media_kind` + derived text.
- **F2 — human preview (biggest human-UX win).** Per-type preview (markdown, code highlight, csv table, pdf.js, ipynb cells, audio player+transcript). Adds the first preview libs.
- **F3 — version diff.** Version-history viewer + per-type diff (line/csv/json/ipynb/image).
- **F4 — expensive/multimodal (opt-in).** OCR + vision caption (lazy, budget-gated); `atrium cat --raw`/`--pages` multimodal byte path; image-diff overlay; video.

---

## 9. Open questions

1. **Eager/lazy boundary.** Confirm the cost line: cheap deterministic eager, LLM/OCR/vision lazy+opt-in? (My lean: yes.)
2. **Multimodal default for `atrium cat image`.** Bytes-to-model by default (when multimodal) vs. caption-by-default? Depends on detecting harness/model multimodal support per session.
3. **Notebooks (.ipynb).** Worth a real cell-level diff/render in v1 (notebooks are common in agent workflows), or treat as `structured`/json until F3?
4. **Vision/OCR provider + budget.** Reuse the LLM-spend path; per-workspace opt-in flag? Which provider for OCR (tesseract local vs. hosted)?
5. **Uploads ↔ artifacts unification.** Confirm we route `files` (uploads) through the same `media_kind`/extraction/preview layer — i.e. do uploads become CAS-keyed so `derived_text` dedups across both? (Strongly recommended; a human-dropped PDF must be agent-readable.)

---

*Grounded in: `surface/server/{migrations/006,024,031,033,036, src/artifact-ledger.ts, artifact-writeback.ts, session-runs.ts (mergeClassForMime ~2606), session-search.ts, stt/*, app.ts (serve ~2374/2698/3231)}` and `surface/web/src/sessions/{ArtifactsSurface,fileChangeView,ConflictSurface,FilesSurface}.tsx` + `components/MessageRow.tsx`, mapped 2026-06-22.*
