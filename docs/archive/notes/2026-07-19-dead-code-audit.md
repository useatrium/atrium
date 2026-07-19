# Dead-code / consolidation audit — 2026-07-19

Method: 4 parallel finder agents (server, web, mobile+desktop, cross-package) seeded with a
zero-config knip run, then 3 adversarial verifier agents instructed to refute every proposal
(full-repo grep incl. `mcp/`, `centaur/`, `runtime/`, deploy scripts, string-built URLs;
hand-computed lifecycles/edit-scenarios for the consolidations). LOC figures include tests.

## Tier 1 — safe deletions, no product decisions (~1,300 LOC) — **this PR**

- `surface/server/scripts/bench-feed.mts` (556) — bench harness for the shipped
  message_state projection work (#473/#475); only refs are `docs/archive/notes/`.
- `surface/server/src/session-debug-captures.ts` + `test/sessionDebugCaptures.test.ts` (181)
  — landed in `c4fb4288`, never wired: no route/job writes or reads the table. Migration
  `054_session_debug_captures.sql` stays (applied in prod).
- `surface/server/src/atrium-projection.ts` + `test/atriumProjection.test.ts` (122) —
  superseded prototype (`projectChatThread`). Not to be confused with the live
  `atrium-channel-projection.ts` / `atrium-session-projection.ts`.
- `surface/server/scripts/conflict-live-e2e.ts` (102) — one-shot live validation; the
  durable scenario is `scripts/two-daemon-conflict-e2e.sh`.
- `surface/shared/src/formatting.ts` + `shared/test/formatting.test.ts` (~110) —
  `tokenizeMessage` superseded by mention wire tokens (#390); drop barrel line in
  `shared/src/index.ts`.
- `surface/shared/src/catchup.ts` (16) — no production caller; drop barrel line
  (`index.ts`) + the import and 3 assertions in `shared/test/reducer.test.ts`.
- `surface/centaur-client/src/claudeQuestions.ts` + `test/claudeQuestions.test.ts` (216) —
  question-bridge POC (`5d30e2b7`) superseded by the server-side HITL relay; drop barrel
  line in `src/index.ts`. Package has `publishConfig` but is verifiably unpublished
  (no publish step in any workflow; only `workspace:*` dependents).
- Dead singles: `isWsTerminal` (`shared/src/useWs.ts`), `userColor` (`shared/src/util.ts`,
  + its characterization assertion in `prefs.test.ts`), `artifactPaths`
  (`centaur-client/src/artifacts.ts`, + its test block; its doc-comment is stale),
  `type ProjectionEvent` (`centaur-client/src/types.ts`).
- `surface/mobile/src/lib/entryHandle.ts` + `test/entryHandle.test.ts` (~54) — prod code
  uses MessageRow's local `entryHandleForAction` instead.
- `surface/mobile/src/lib/sessionSuggestion.ts` (~11) + its section of
  `test/agentMode.test.tsx` — only that test references it.

## Tier 2 — safe deletions with real companion edits (~950 LOC) — not yet executed

- **Session-scoped files API** — `surface/server/src/routes/files.ts` (~550 net).
  Superseded by the Files Hub; web consumer retired (`WorkDrawer.tsx` comment); zero refs
  in clients / node-sync / mcp / centaur. Companion edits (verified):
  unwire `app-routes.ts:19,175`; in `test/filesRoute.test.ts` delete only the
  `PUT /api/sessions/:id/files` describe block (~85–182) — lines 1–84 are shared fixtures
  the surviving locator tests need; **rewrite** the 3 scope tests in
  `test/artifactScopeRoutes.test.ts:202–270` (they assert session-scoped
  `activePrefix`/`readableRoots`/`writableRoots` shapes with no files-hub drop-in).
- **Human-facing `/atrium/*` doc mirror** — most of `surface/server/src/routes/atrium.ts`
  (~260 incl. tests). Keep `GET /api/sessions/:id/atrium/capabilities` (web uses it).
  Internal-atrium twin covers every doc kind for node-sync; the public `/atrium/chat`
  handler is a stale duplicate projection that ignores message_state edits. Companion
  edits: delete `test/atriumChatProjection.test.ts`; trim 5 public-route call sites in
  `src/atrium-internal.test.ts` (~:280, :288, :366, :548, :573); remove orphan
  `loadChannelChatMessages` (`atrium-channel-projection.ts:164`).
  **Open question: were these intended as operator curl-debug endpoints?** If used
  operationally, keep.
- **Web never-rendered components** (~350 incl. tests): `ArtifactsSurface` component
  (`ArtifactsSurface.tsx:258–378`; keep `ArtifactTile`/`ArtifactPreviewModal`/
  `latestArtifactsByPath`), `ChangesSurface` component (`ChangesSurface.tsx:55–115`; keep
  `ChangeFileRow`/`groupFileChanges`), `ReasoningBlock.tsx`, `EntryQuoteCards` (plural,
  `EntryQuoteCard.tsx:592`), `SessionAppPresentationCards` (`AppPresentationCard.tsx:127`),
  cacheIdb alias re-exports (`cacheIdb.ts:438–441` only — `clearCache` at 442 is real),
  `loadUserDirectory` (`userDirectory.ts:81`). Must also delete
  `web/test/artifactsSurface.test.tsx`, `web/test/changesSurface.test.tsx`,
  `web/test/reasoningBlock.test.tsx`.

## Consolidations — verified feasible, decisions pending

- **`useSessionStream`** (web 93 LOC / mobile 89 LOC, 93% identical): shared core taking a
  transport factory; verifier hand-checked the full lifecycle in both — no divergence.
  Decision: host in `shared/` (new cycle-free `shared → centaur-client` dep edge) or in
  `centaur-client` (needs a `react` peer-dep). ~75 LOC deduped.
- **Mention range math** (`useMentionTypeahead.ts:73–95` vs `mentionComposer.ts:13–36`):
  proven algebraically equivalent (the extra `start<E` disjunct is redundant when
  `start===E`). Mechanical fold into `shared/src/mentions.ts`.
- **`chatQueuedOverlays` → shared + mobile adoption** (~250 LOC): the move is mechanical
  (only non-shared import is a re-exported `Session` type), but mobile's inline copies
  diverged in 6 optional fields — mobile populates `repos`/`githubIdentityMode`/
  `agentProfileVersionId` and has a multi-repo `repo`/`branch` fallback web lacks; web
  sets `sessionTask` + `attachments` on the optimistic spawn message and
  `providerAuthRequired: null`, mobile omits them; `waveform`/`voiceFileId` handling
  differs. Reconcile to the union first (the divergences read like latent bugs), then adopt.
- **`useCall`** (web 744 / mobile 902, 34% shared): needs a designed call-core with
  platform hooks around CallKit. High regression risk (CallKit verified on real iPhone).
  Deferred — only if calls churn again.
- **FilesHub → Gallery** (~1,400): **refuted as a deletion.** Gallery at the detached
  `hub-files` site would lose folder navigation, star toggling, label add/remove, inline
  MarkupPane, apply-markup, and EntryReferencesChip. (Version history, text edit/save, and
  conflict resolution are *not* FilesHub-only — shared via
  `fileHubCore.createFileLightboxCallbacks`.) Viable only as a feature-port project.

## Refuted / false positives — do not delete

- `pendingAnswers.flushScheduledAnswers` — live `pagehide` handler (`pendingAnswers.ts:181`);
  `resetScheduledAnswers` used by 2 tests.
- `MemoryOpStorage` (`shared/src/opQueue.ts:595`) — load-bearing fixture, instantiated
  ~30× and subclassed in `opQueue.test.ts:811`.
- `fileChangesFromItems`/`normalizeCodexFileChange` — called internally by
  `collectFileChanges`/`codexInlineFileChanges`.
- knip false positives: `web/public/sw.js` (string-registered, `main.tsx:41`); mobile
  `babel.config.js` + `babel-preset-expo` (Metro-implicit; reanimated plugin mandatory);
  `desktop/build/notarize-dmg.cjs` (`electron-builder.yml` `afterAllArtifactBuild`);
  desktop icon-gen scripts (regenerate committed assets); server seed scripts (shell
  harnesses), `rebuild-message-state.mts` (referenced from migration 080),
  `reconcile-github-connections.ts` (ops runbook tool); mobile cache layer (live via
  `cacheSqlite.ts`); `entry-reaction-state.ts` (its test is a live oracle of the
  `refold_entry_reactions` SQL function).
