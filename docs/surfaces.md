# Atrium surfaces

The UI surfaces a person actually touches, and how they compose. The **web app**
(`surface/web`) is canonical and has everything below; the **desktop app**
(`surface/desktop`) is an Electron shell around that same web build, so it has
the same surfaces; **mobile** (`surface/mobile`, Expo) is a subset — chat, voice,
and reading sessions — with the heavier session work-surfaces simplified.

File paths below are under `surface/web/src/`.

## Layout grammar

Most of the app lives in one shell (`Chat.tsx`) with three slots:

- **Sidebar** (left) — workspace, channels, DMs, presence, unread, settings.
- **Main** (center) — the active channel timeline, with the thread panel beside it.
- **Rail / pane** (right) — the sessions rail, or an agent session pane.

A segmented **Channel · Split · Focus** control (`sessions/ViewToggle.tsx`) sets
how much room the session pane gets. Session work-surfaces follow a
**peek → pin → detach** ladder: peek overlays the transcript, pin docks it beside
the transcript, detach opens it as its own full-page tab.

Routes: `/` (app), `/s/:id` (session permalink), `/s/:id/work/:slug` (a detached
work surface), `/search` (session search).

## Sign in

- **Login** (`Login.tsx`) — handle, or email + one-time code (Google OAuth when
  enabled). On desktop the returned bearer token is stored in the OS keychain.

## Chat

- **Sidebar** (`components/Sidebar.tsx`) — channel list, DMs (1:1 + group),
  unread dots, presence, create-channel / start-DM, mute, settings, log out.
- **Channel timeline** (`components/Timeline.tsx`, `components/MessageRow.tsx`) —
  messages grouped by author/time, reactions, edit/delete, read marker, inline
  session cards from `@agent` spawns, inline file-change cards, attachments,
  history paging.
- **Thread panel** (`components/ThreadPanel.tsx`) — a root message and its
  replies (full-screen on mobile), with its own composer and draft.
- **Composer** (`components/Composer.tsx`) — text + attachments + voice; detects
  `@agent <task>` and opens the spawn dialog instead of posting; per-channel
  drafts; typing indicators.
- **Quick switcher** (`components/QuickSwitcher.tsx`) — keyboard jump to a
  channel or session.
- **Toasts** (`components/Toasts.tsx`) — transient errors/confirmations.

## Voice

- **Calls** (`components/CallUI.tsx`, `useCall.ts`) — incoming-call banner
  (accept/decline), in-call panel (participants, mute, leave). Media over LiveKit.
- **Voice messages** (`VoiceRecorder.tsx`, `VoiceMessage.tsx`) — record with a
  waveform, send, and play back inline; async speech-to-text transcript.

## Agent sessions

- **Spawn dialog** (`sessions/SpawnDialog.tsx`) — task, harness (Codex / Claude
  Code), optional repo + branch, and advanced GitHub identity selection; warns if
  a private repo needs a GitHub connection or if no subscription credential is
  connected.
- **Session pane** (`sessions/SessionPane.tsx`) — live transcript of a session
  (messages, tool calls, reasoning, suggestions, artifacts) with status, cost,
  elapsed time, a steer composer, answer-question prompts, and cancel.
- **Sessions rail** (`sessions/SessionsRail.tsx`) — per-channel list grouped into
  *Needs you* / *Active* / *Recent*; click to peek a session.
- **Session search** (`sessions/SessionSearch.tsx`) — full-text search across all
  session records, filterable by record kind, deep-linking to a session.

## The Work drawer

Everything a session produced, behind one drawer (`sessions/WorkDrawer.tsx`),
opened from the transcript and following peek → pin → detach. Tabs:

- **What changed** (`sessions/WhatChangedSurface.tsx`, `ChangesSurface.tsx`) —
  files the agent edited (collapsible diffs) plus a gallery of captured artifacts
  (one tile per path, newest-wins, version count).
- **What it ran** (`sessions/SideEffectsSurface.tsx`) — the agent's side-effects
  (network / package / git / filesystem / process / shell) with risk badges.
- **Browse files** (`sessions/FilesSurface.tsx`) — read-only tree of the session's
  repo (git-backed) and captured artifacts (ledger-backed), with version history.
- **Artifacts** (`sessions/ArtifactsSurface.tsx`) — the work-product gallery,
  served via presigned URLs from the session's CAS ledger. Executable previews
  render inside sandboxed iframes; raw open/download flows use the non-executing
  artifact byte route.
- **Conflicts** (`sessions/ConflictSurface.tsx`, `useConflicts.ts`) — appears only
  when two actors edited the same artifact concurrently; shows base/left/right
  (jj-style, both sides preserved) and lets you resolve.

A **detached work tab** (`sessions/SessionWorkPage.tsx`, `/s/:id/work/:slug`)
renders any one of these full-page, folding the same live session stream.

Artifact roots are path-scoped: session-private scratch under
`scratch/<session-id>`, workspace/global work under `shared/global`, app bundles
under `shared/apps`, and channel work under `shared/channels/<channel-id>`. The
active channel is writable for a session; other readable channels are browsable
context, not write targets.

## Settings & connectors

- **Settings** (settings popover in `components/Sidebar.tsx`, `theme.tsx`) —
  theme (system/light/dark), accent, text size, high-contrast, motion,
  notifications. Synced to the server across devices.
- **Connectors** (`components/GitHubConnectionDialog.tsx`,
  `components/ClaudeConnectDialog.tsx`, `components/CodexConnectDialog.tsx`) —
  connect GitHub identities for repository access and personal Claude Code or
  Codex subscriptions so sessions bill to them instead of the workspace default.

## Platform coverage

| Area | web | desktop | mobile |
|---|---|---|---|
| Chat (channels, threads, DMs, reactions) | ✓ | ✓ | ✓ |
| Voice (calls + voice messages) | ✓ | ✓ | ✓ |
| Agent sessions (spawn, transcript, steer) | ✓ | ✓ | ✓ (read-leaning) |
| Work drawer (changes / files / side-effects / conflicts) | ✓ | ✓ | peek-only, no pin |
| Settings & provider connectors | ✓ | ✓ | ✓ |
