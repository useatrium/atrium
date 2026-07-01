# Unified Files Hub + Universal Preview + Upload Parity — plan

> Scoped from `master` on 2026-06-30, grounded in a code-verified pass of the upload →
> storage → render paths (file refs inline). Goal (Gary): **merge uploads into
> artifacts** (one object model, tagged by source/location), give **every file type a
> good preview + lightbox**, and reach **web/mobile parity**. This composes with — does
> not supersede — [`artifact-media-extraction-search-plan.md`](./artifact-media-extraction-search-plan.md)
> (the `MediaPreview` seam + classification) and [`artifact-file-types-design.md`](./artifact-file-types-design.md)
> (the `media_kind` taxonomy). It is the **human-facing hub + lightbox + composer** layer
> on top of those.

---

## 1. The one-paragraph thesis

Uploads are today a message-only, second-class object rendered through a weaker path than
agent artifacts. But the **storage substrate is already unified**: every chat upload
auto-lands in the CAS artifact ledger, and the ledger is already **workspace-scoped**. So
"merge uploads into artifacts" is ~80% a **presentation + query-surface + tagging** job on
an already-unified data model — not a storage migration. The build is: (A) cross-scope
listing/query, (B) one Files hub, (C) a universal preview/lightbox, (D) inline-message
click-through, (E) soft-delete, (F) composer parity.

---

## 2. Locked decisions (from Gary, 2026-06-30)

| Decision | Choice |
|---|---|
| Merge scope | **One unified Files hub** — uploads + agent artifacts + workspace files, tagged by source + location |
| Browse scope | **Per-channel + a global workspace "all files" search** |
| Preview types | **All** — media (image/video/audio), documents (PDF/office), text & code, data (CSV/ipynb) |
| Lightbox features | **All** — navigate + zoom/pan, download + copy-link, info panel, manage (rename/delete/comment) |
| Parity gaps | **All** — pre-send thumbnails on web, camera on mobile, unified limits/types, full lightbox+hub on mobile |
| Filter/tag axes | **All** — source, type, location, custom labels + starred |
| Search depth | **Filename + metadata only** (deliberately no extraction/index pipeline — see §7) |
| Delete/edit | **Soft-delete + tombstone** (recoverable via ledger versions) |
| Hub contents | **Everything you can access** — shared/* + your own private `scratch/`, per-viewer scoped, source-filterable |
| Byte serving | **Hybrid** — presigned redirect for download/images; authenticated Atrium proxy w/ Range for streamed media |
| Delete vs history | **Tombstone wins** — soft-delete retracts from the message too, overriding the version pin |
| Manage perms | **Owner + workspace admins** |

Defaults assumed (Gary to veto): agents stay read-only on human uploads (agent edits =
new attributed version, never silent overwrite); re-upload of same filename = new version;
unified size cap 25 MB → **100 MB**, count cap **10**; **office-doc rich preview is
phase 2**, all other types phase 1.

---

## 3. Current state (verified on `master`, file:line)

**Storage / identity — already unified, already workspace-scoped:**
- Uploads auto-land as artifacts at `shared/channels/{channelId}/uploads/{filename}` via
  `landUploadAttachmentAsArtifact()` — `surface/server/src/routes/messages.ts`. Chat
  immutability preserved by version-pinning the message's `(artifact, seq)`.
- Artifact identity = **`(workspace_id, path)`** since `migrations/042_workspace_scoped_artifacts.sql`
  (`session_id` nullable, `ON DELETE SET NULL`; artifacts outlive sessions). **No feature
  flag — on by default.**
- Byte model: `artifact_versions.blob_sha → cas_blobs(sha256, s3_key, mime, size_bytes)`;
  single-CAS invariant (blob has `s3_key` before a non-delete version commits) — B2 hard
  cut, `artifacts-followups.md`.
- Media classification present: `cas_blobs.detected_mime / media_kind / is_text /
  text_encoding / classification_meta` — `migrations/049_cas_blob_media_classification.sql`.
- Scope classifier (`surface/server/src/artifact-scope.ts`): **private** `scratch/{sessionId}/`;
  **workspace-readable** `shared/global/`, `shared/apps/`, `shared/channels/{id}/`.
- Uploads also keep an ingest row in `files` (`migrations/006_files.sql`, `020_upload_content_hash.sql`)
  keyed `{fileId}/{filename}` in S3, 25 MB cap — `surface/server/src/routes/uploads.ts`.

**The gaps this plan closes:**
- **No cross-scope listing.** Every artifact list is session-scoped
  (`GET /api/sessions/:id/files` → `ledger.sessionScope(id)`, `WHERE session_id = $1`).
  There is **no** `GET /api/workspaces/:id/files` or channel-level list. The only
  channel-level route, `PUT /api/channels/:channelId/artifacts`, still requires `?session=`.
  → the hub's backbone.
- **Weak, split rendering.** Inline in the bubble (`surface/web/src/components/MessageRow.tsx:297-338`):
  images → `<img>` linking to `/api/files/{id}` **in a new tab**, everything else → a
  download chip. Agent artifacts get a separate gallery + iframe modal
  (`surface/web/src/sessions/ArtifactsSurface.tsx`); workspace files a third browser
  (`surface/web/src/sessions/FilesSurface.tsx`). Three paths, no shared lightbox. No PDF /
  markdown / code / CSV / notebook / video renderers exist (no preview libs installed).
- **Byte serving = presigned S3 302 redirect** (`GET /api/files/:id`, `routes/uploads.ts`),
  **no Atrium-side Range support** — matters for video scrubbing + large-PDF paging (§Open).
- **Composer asymmetry.** Web (`surface/web/src/components/Composer.tsx`): drag + paste +
  paperclip, 10 files, **icon+filename only (no pre-send thumbnail)**. Mobile
  (`surface/mobile/src/components/Composer.tsx`): library (5) + document picker, real
  thumbnails, **no camera**. Limits/types differ.

**Already fixed / already scoped — do not rebuild:**
- Binary-safety corruption bug (`FilesSurface` blindly `response.text()`-ing binaries) is
  **fixed** — it now branches on `is_text` (server sends `X-Is-Text`).
- The reusable **`MediaPreview` seam** is already designed in
  `artifact-media-extraction-search-plan.md` §Phase 4 (one component for FilesSurface +
  ArtifactsSurface + MessageRow + mobile). Workstream C **is** that seam — build it there.

---

## 4. Workstreams

### A — Cross-scope listing & query (backbone)
Generalize the ledger read path off `session_id`.
- Ledger query by **workspace** and by **channel** (union: `shared/*` workspace-readable +
  the viewer's own `scratch/{session}` where applicable) with scope filtering via
  `artifact-scope.ts`. Extend `artifact-ledger.ts` (today `WHERE session_id = $1`).
- New routes: `GET /api/workspaces/:id/files` (global) and `GET /api/channels/:id/files`
  (per-channel), with `filter` (source/type/location/labels/starred), `sort`, `q`
  (filename+metadata), pagination. ACL-filtered by scope resolver.
- **Source derivation**: `origin ∈ {upload, agent, workspace}` from path + `artifact_versions.author`
  (`human:{userId}` + `…/uploads/` = upload; agent author = agent; else workspace). Uploader
  identity surfaced in the list payload.
- **Source-message backlink**: persist `source_message_id` on the upload's version metadata
  so a file links back to the message it came from (today only message→file exists).

### B — The Files hub surface (absorbs ArtifactsSurface + FilesSurface)
One `FilesHub` component, two scopes (per-channel default; global "All files").
- Filter/sort/tag on **source · type · location · labels/starred**; **filename+metadata search**.
- Grid + list, thumbnails. **Contents = everything the viewer can access**: `shared/*`
  (workspace-readable) unioned with the viewer's own `scratch/{session}` across their
  sessions, ACL-filtered per viewer via `artifact-scope.ts`, with a `source` filter (incl.
  "shared only"). → the global list is **per-viewer** (not a single cached workspace list);
  the query gathers the viewer's session set to include their scratch.
- Labels are **shared** workspace metadata; stars are **per-user**.
- New tables `artifact_labels(artifact_id, label, created_by)` + `artifact_stars(artifact_id, user_id)`
  (surface migration `050+`).
- Keep the two legacy surfaces working behind a flag during migration, then cut over (the
  pattern shared-workspace shipped with).

### C — Universal preview + lightbox (build the `MediaPreview` seam)
One `<FilePreview>` dispatched on `media_kind`, wrapped in a `<Lightbox>` shell; reused by
the hub, the message bubble, and mobile.
- **Media**: image with pinch/scroll zoom + pan; video/audio inline player.
- **Documents**: **PDF via pdf.js** paged viewer (phase 1). Office (docx/xlsx/pptx):
  best-effort client libs (docx-preview / SheetJS) or download-fallback — **phase 2**.
- **Text & code**: syntax highlight (shiki) + rendered Markdown.
- **Data**: CSV/tabular as a virtualized table; `.ipynb` rendered cells.
- **Lightbox chrome**: prev/next across the current collection, zoom/pan, keyboard + swipe,
  download + copy-link, **info panel** (size, dims, uploader, when, source message/session),
  **manage** (rename, soft-delete, comment — comments reuse the addressable-entries /
  annotations system, not a new store).
- Reuses the `media_kind` taxonomy + preview matrix from `artifact-file-types-design.md` §3/§7.
- **Byte serving = hybrid** (decided): presigned S3 302 redirect for downloads + still
  images; a **new authenticated Atrium proxy route with HTTP Range (206)** for streamed
  media (video/audio, large PDF paging). Route by `media_kind`. `copy-link` yields a
  **stable ACL-gated app route** (e.g. `/files/:artifactId`), never a raw expiring
  presigned URL. Atrium bears streamed-media bandwidth; add Range parsing (absent today).

### D — Inline message → lightbox
Keep the bubble chip/thumbnail (`MessageRow.tsx`), but **click opens the unified lightbox**
(with that message's other attachments as the nav set) instead of a raw new tab. Uploaded
images finally get the agent-artifact-grade viewer.

### E — Soft-delete + tombstone (delete wins)
Ledger already supports `kind='deleted'` versions.
- `DELETE /api/files/:id` (and artifact path variant) appends a `deleted` version
  (recoverable by re-pinning a prior seq); rename = a metadata version. **Perms: owner
  (author) or workspace admin** — verify a workspace-admin role exists; if not, add a
  minimal role check.
- **Tombstone wins over the pin** (decided): the message version-pins `(artifact, seq)`, but
  on delete the render + serve paths must check the artifact's tombstone state at read time
  and show **"file removed"** even though the pinned seq still resolves to bytes. So message
  attachment rendering shifts from "resolve pinned seq → show" to "resolve pinned seq, but
  if artifact is tombstoned → removed placeholder"; the byte route 404s/placeholders a
  deleted file even via the pinned message link. Un-delete restores. Hub hides deleted (with
  a "show removed" toggle).

### F — Composer parity (web ↔ mobile)
- **Web**: pre-send thumbnails (object-URL previews) — `web/src/components/Composer.tsx`.
- **Mobile**: camera capture (`ImagePicker.launchCameraAsync`) — `mobile/src/components/Composer.tsx`.
- **Unify** file-count cap, size cap, accepted types across both.
- **Full lightbox + hub on mobile** (swipe, pinch-zoom) — Workstreams B/C are RN-parity, not
  web-only.

### G — Thumbnails / perf (optional, phase 2)
Server-side thumbnail/poster generation for fast gallery + big images/video. Launch can
serve originals with client-side sizing; add if the gallery feels heavy.

---

## 5. Sequencing
1. **A + B** — listing/query + hub → the "find any file again" win.
2. **C + D** — universal preview/lightbox + inline click-through → the "good previews" win.
3. **F** — composer parity.
4. **E** (+ **G**) — soft-delete, thumbnails/perf hardening.

Office previews (C phase 2) and thumbnails (G) are the two deferrable tails.

---

## 6. Resolved decisions (Gary, 2026-06-30) + build implications

1. **Hub contents = everything the viewer can access** (shared/* + own private `scratch/`).
   → global list is per-viewer; union the viewer's session scratch with workspace-readable
   shared paths; `source` filter incl. "shared only". Workstream A/B.
2. **Byte serving = hybrid** — presigned redirect for download/images, authenticated Atrium
   proxy w/ Range (206) for streamed media; `copy-link` = stable ACL app route. → new proxy
   route + Range parsing; MinIO CORS still needed for in-page presigned `<img>`. Workstream C.
3. **Soft-delete = tombstone wins** — delete overrides the message's version pin; render +
   serve check tombstone at read time. → attachment render + byte route must honor deletion
   even on a pinned seq. Workstream E.
4. **Manage perms = owner + workspace admins.** → delete/rename check `author == viewer`
   OR viewer is workspace admin (verify the admin role exists). Workstream E.

---

## 7. Deliberately out of scope (this round)
- **Content search / OCR / derived-text index.** Gary chose filename+metadata search. The
  full derived-text pipeline (`derived_text` table, extraction worker, `artifact_search_documents`)
  is designed in `artifact-media-extraction-search-plan.md` §Phase 2-3 and remains a future
  extension — the hub's search should be built so it can later swap in content search
  without a UI rewrite.
- **Version diff viewer** for blobs (image onion-skin, ipynb cell diff) — `artifact-file-types-design.md`
  §7 / F3. The lightbox shows version *history*; per-type *diff* is later.
- **Agent-side `atrium cat`/typed reads** — agent-UX, tracked in the file-types design.

---

## 8. Risks
- **Office-doc preview** is the one genuinely hard type → phase 2, honest split.
- **Surface consolidation** (FilesSurface + ArtifactsSurface → FilesHub) touches live session
  UI; flag + gradual cutover.
- **Scope leakage**: the global view must respect `artifact-scope.ts` so private `scratch/`
  session artifacts never leak workspace-wide — a hard review gate.
- **CORS**: the hybrid model still uses presigned redirects for in-page `<img>`, so MinIO/S3
  needs CORS configured; the proxy leg avoids it for streamed media.
- **Tombstone at read time**: because delete overrides the pin (Decision 3), every artifact
  read path (message render, byte serve, hub, previews) must consult tombstone state — miss
  one and a "deleted" file still leaks through that path. Enumerate read paths before E ships.
- **Per-viewer global list** (Decision 1) can't be a single cached workspace query — watch
  N+1 / fan-out cost when unioning many sessions' scratch; paginate + index by workspace_id.

---

*Grounded in: `surface/server/{routes/uploads.ts, routes/messages.ts, routes/files.ts,
routes/artifacts.ts, artifact-ledger.ts, artifact-scope.ts, migrations/006,020,033,042,049},
surface/web/src/{components/Composer.tsx, components/MessageRow.tsx,
sessions/ArtifactsSurface.tsx, sessions/FilesSurface.tsx}, surface/mobile/src/components/Composer.tsx`,
mapped 2026-06-30. Composes with `artifact-media-extraction-search-plan.md`,
`artifact-file-types-design.md`, `artifacts-followups.md`.*
</content>
</invoke>
