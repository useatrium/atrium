# Unified Files Hub — follow-up plan (what's left)

> Finalized 2026-07-01 after the Files Hub shipped (PRs #191 phase-1, #192 phase-2, #193
> mobile-crash-fix, #195 e2e, #196 mobile msg→lightbox). Cross-checked the original plan
> (`unified-files-hub-plan.md`) against `master`: everything in scope landed and is
> e2e/sim-verified. This note captures the **remaining work + Gary's decisions** on it.
> Companion: `unified-files-hub-plan.md`, `artifact-media-extraction-search-plan.md`,
> `artifact-file-types-design.md`.

## Decisions (Gary, 2026-07-01)
| Item | Decision |
|---|---|
| File comments (lightbox "Comment" is a stub today) | **Wire to real comments** (reuse annotations/`EntryComments`) — verify a file-artifact can carry a comment anchor first |
| Hub absorbs from legacy surfaces | **Version history + restore**, **text/code editing**, **HTML/app preview** |
| Legacy surface retirement | **Retire "Browse files" (`FilesSurface`) only**; **keep** the Artifacts gallery (`ArtifactsSurface`) for the agent-artifact gallery + published apps |
| Also in scope now | **Version-diff viewer**, **PDF gallery thumbnails**, **pptx rich preview** |
| `source_message_id` file→message backlink | **Fix it** (populate reliably) |
| `atrium cat` (agent typed reads) | **Dropped** — see rationale below |
| Content-search / OCR | **Backlog** (keep filename+metadata; hub search built to swap it in later) |
| Rollout | **Incremental slices, no flag**; retire "Browse files" last, only once covered |

**Why drop `atrium cat`:** uploaded files land at `shared/channels/{id}/uploads/` which is in the
agent's hydration `readableRoots` (`internal-artifacts.ts` `activePrefix = shared/channels/{channelId}`),
so they're **already real files on the agent's `/context` mount** — the agent reads them with normal
tools, and modern harnesses (claude/codex) read images/PDFs natively. The one unique thing `atrium cat`
offered — cheap derived-text/OCR for *grep-ability* — belongs to the (backlogged) content-search
pipeline, not a standalone CLI. So it adds ~nothing today.

---

## Slices (each ≈ its own PR; incremental, no flag; land green)

### Slice 1 — File comments + file→message backlink (small)
- **Comments:** wire the lightbox `onComment` (today `FilesHub.tsx:620` → toast stub) to the real
  `EntryComments` thread, anchored to the file's addressable entry-handle.
  - **Gate/verify first:** the annotation system anchors to *message* entry-handles today; confirm a
    file/artifact can carry a comment anchor (per [[addressable-entries-annotations]] artifacts are
    addressable). If not, add a minimal artifact comment-anchor server-side (bumps S→M).
- **Backlink:** populate `artifact_versions.source_message_id` reliably so a file can "jump to the
  message it came from" (today only set when a UUID `client_msg_id` exists — thread a stable id).
- Verify: e2e — post a file, comment on it, reload → comment persists; file resolves its source message.

### Slice 2 — Version history + restore + version-diff (medium)
- **History + restore:** the ledger already versions by `(workspace, path)` (`artifact_versions`,
  `artifact_pointers`) and a `POST /api/files/:artifactId/restore` exists — surface a **history panel**
  (list versions, author, when) in the lightbox with **restore to seq**. (Replaces `ArtifactsSurface`'s
  version count + `FilesSurface`'s `/files/history`.)
- **Version-diff:** compare two versions — **text intra-line**, **image onion-skin/side-by-side**,
  **ipynb cell diff**. New diff renderers under `web/src/components/media/`.
- Files: web media/ (history panel + diff renderers); server (a versions-list endpoint if not already
  present).

### Slice 3 — Text/code editing in the hub (medium)
- Edit + save `is_text` files in the lightbox/hub via the **existing writeback** (channel-artifact
  writeback / files writeback already exist server-side) and its **diff3 conflict handling** (reuse
  `ConflictSurface`). In-lightbox editor pane for `is_text`; non-text stays read-only. (Replaces
  `FilesSurface`'s edit.)

### Slice 4 — HTML/app preview in the lightbox (medium)
- Render agent-built HTML/JSX-TSX artifacts in the lightbox via the **existing preview engine**
  (`/api/sessions/:id/artifacts/preview?renderer=react-jsx|html-app`, the `ArtifactPreviewModal` route)
  as a lightbox `app` renderer. **Shared engine** with `ArtifactsSurface` — do NOT fork a second
  renderer. (Gives the hub app-preview without touching the kept Artifacts gallery.)

### Slice 5 — PDF thumbnails + pptx preview (small–medium)
- **PDF posters:** server-side first-page thumbnails (extend `server/src/thumbnails.ts`; P3 skipped this
  to avoid a native pdf→image dep — re-evaluate: `pdfium`/`pdf-to-img`/headless. Cost the dep before
  committing).
- **pptx:** render slides in the `OfficeRenderer` instead of download-only. Genuinely hard client-side;
  may land as best-effort or a server-side convert-to-images — flag if fidelity is poor.

### Slice 6 — Retire "Browse files" (`FilesSurface`) (small)
- Once slices 2–4 cover history/edit (browse is already in the hub), remove `FilesSurface` from
  `WorkDrawer` (the `files`/"Browse files" tab) and delete the component.
- **Parity gate:** confirm the hub's **location/path filtering** is an adequate replacement for
  `FilesSurface`'s directory-tree nav; if folder navigation is still wanted, add a path breadcrumb to the
  hub first. **Keep `ArtifactsSurface`** (per decision).

---

## Sequencing
1. **Slice 1** (comments + backlink) — closes the last stubbed gap; smallest.
2. **Slices 2–5** (hub parity + the extra previews) — fanout-friendly (disjoint: history/diff, edit,
   app-preview, thumbnails are separate files); land each green.
3. **Slice 6** (retire Browse files) — last, only after 2–4 land.
- **Backlog (not now):** content-search/OCR (`derived_text` pipeline), agent `atrium cat`.

## Risks / open checks
- **Comment anchor** (Slice 1) — verify artifacts can carry a comment anchor before building; this gates
  the slice's effort.
- **Hub vs tree nav** (Slice 6) — the hub is flat+filtered; `FilesSurface` was a directory tree. Confirm
  location-filter parity (or add breadcrumbs) before retiring.
- **App-preview reuse** (Slice 4) — reuse the artifacts preview route; two engines = drift.
- **PDF poster + pptx** (Slice 5) — both need a heavier dep or server convert; the reason P3/plan-phase-2
  deferred them. Re-cost before committing.
- **source_message_id** (Slice 1) — message event ids are numeric; a reliable backlink may need a stable
  per-message UUID surfaced on the event.
</content>
