# Atrium surfaces

The UI surfaces a person actually touches, and how they compose. The **web app**
(`surface/web`) is canonical and has everything below; the **desktop app**
(`surface/desktop`) is an Electron shell around that same web build, so it has
the same surfaces; **mobile** (`surface/mobile`, Expo) covers chat, voice,
files, attention, search, and full session driving (spawn, steer, seat
handoff), with the heavier work surfaces simplified into sheets.

File paths below are under `surface/web/src/`.

## Layout grammar

Most of the app lives in one shell (`Chat.tsx`) with three slots:

- **Sidebar** (left) — workspace nav (Files / Agents / Attention), channels,
  DMs, presence, unread, settings. Drag-resizable; width persists per device.
- **Main** (center) — one surface at a time: the active channel timeline, or
  Files, Attention, Agents, or Settings.
- **Right slot** — the session pane, the thread panel, or the sessions rail.
  Session pane and thread panel are both drag-resizable.

A segmented **Channel · Split · Focus** control (`sessions/ViewToggle.tsx`) sets
how much room the session pane gets (Focus persists as a `?view=focus` param).
Session work-surfaces follow a **peek → pin → detach** ladder: peek overlays the
transcript, pin docks it beside the transcript, detach opens it as its own
full-page tab.

### URL grammar (`router.ts`)

Paths are places; query params are view modifiers, so every navigational state
survives refresh and can be linked:

- `/` — default channel
- `/c/:channelId` — channel; `/c/:id/s/:sessionId` adds the session pane,
  `/c/:id/t/:rootId` opens a thread, `/c/:id/members` the members view
- `/files` · `/activity` · `/agents` · `/settings[/:section]` — workspace surfaces
- `/s/:sessionId` — legacy session permalink (canonicalizes into a channel URL)

Query params: `file` (artifact lightbox) + `panel` (its info/history side
panel), `work` (in-pane work-drawer tab), `dir` (Files folder), `preview`
(artifact/app preview), `view=focus`; `entry` and `threadRoot` are inbound-only
deep-link params.

A few routes render outside the shell: `/e/:handle` (portable entry links,
`EntryLinkRoute.tsx` — resolves and redirects to the real destination),
`/s/:id/pane` (a lean popout session pane, `sessions/SessionPanePage.tsx`),
`/s/:id/work/:slug` (a detached work surface, `sessions/SessionWorkPage.tsx`),
and `/markup/shell` (the WebView host the mobile app embeds for the markup
editor).

## Sign in

- **Login** (`Login.tsx`) — up to three paths, per `GET /auth/methods`: open
  handle login (dev default), email one-time code, and Google OAuth when
  configured. On desktop the session token is encrypted at rest via the OS
  keychain (Electron `safeStorage`).

## Chat

- **Sidebar** (`components/Sidebar.tsx`) — workspace nav (Files, Agents,
  Attention with a live badge), pinned conversations, channel list, DMs (1:1 +
  group), archived group, unread dots and mention badges, create-channel /
  start-DM, hover actions per channel (pin, archive, mute), settings, log out.
- **Channel timeline** (`components/Timeline.tsx`, `components/MessageRow.tsx`)
  — messages grouped by author/time, reactions, edit/delete, unread divider and
  jump-to-latest, inline session cards from agent summons (with a live presence
  ticker), file-change and entry-quote cards, attachments, voice playback,
  history paging, a first-run empty state.
- **Message actions** (`components/MessageActionMenu.tsx`,
  `components/SelectTextSheet.tsx`) — reply in thread, delegate to agent, mark
  up & reply, copy link, copy text; a touch-friendly select-text sheet.
- **Thread panel** (`components/ThreadPanel.tsx`) — a root message and its
  replies (full-screen on mobile), with its own composer, drafts, and a
  broadcast-reply toggle.
- **Composer** (`components/Composer.tsx`) — text + attachments + voice; a
  first-class **agent mode** (enter with `!!`, the ⚡ button, ⌘J, or "Delegate to
  agent…" on a message) with a target pill (new agent / steer / suggest), anchor
  chip, and effort tier — sends spawn or steer instead of posting; @ mention
  typeahead (`useMentionTypeahead.ts`) for people plus `@channel` / `@here`
  (`@agent` is retired; mentions are for people); per-channel drafts; typing
  indicators.
- **Quick switcher** (`components/QuickSwitcher.tsx`) — ⌘K: commands, channel
  jump, full-text message search, and agent/session search in one list.
- **Toasts** (`components/Toasts.tsx`) — transient errors/confirmations.

## Attention

- **Attention** (`components/ActivityView.tsx`, `/activity`) — the "what needs
  me" surface. A pinned **Needs attention** tier (agent questions, provider
  auth, failed sessions) above an activity history (mentions, DMs, thread
  replies, session completions, reactions, invites, seat requests, missed and
  declined calls). Per-item read state against a watermark, mark-all-read, and
  the sidebar badge; rows deep-link to the channel or session.

## Files

- **Files** (`sessions/Gallery.tsx`, `/files`) — the workspace file gallery:
  one tile per file with scope (everything / channel / session) and origin
  (upload / agent / workspace) filters, folder browsing, text search, and a
  lightbox with info/history panels. The folder-aware hub view
  (`sessions/FilesHub.tsx`) also backs the session work drawer's Files tab.

## Voice

- **Calls** (`components/CallUI.tsx`, `useCall.ts`) — incoming-call banner
  (accept/decline), a join strip for live channel calls, in-call panel
  (participants, active speakers, mute, leave). Media over LiveKit. Missed and
  declined calls land in Attention.
- **Voice messages** (`VoiceRecorder.tsx`, `VoiceMessage.tsx`) — record with a
  waveform, send, and play back inline; async speech-to-text transcript.

## Agent sessions

- **Spawn dialog** (`sessions/SpawnDialog.tsx`) — task, harness (Codex / Claude
  Code), optional agent profile, working repo + branch plus reference repos,
  and advanced GitHub identity selection; warns if a private repo needs a
  GitHub connection and notes when a run will use the workspace's default
  agent auth instead of a connected subscription.
- **Session pane** (`sessions/SessionPane.tsx`) — live transcript with status
  banners, turn status (phase, elapsed, tokens, cost, stop), a collapsible plan
  panel, suggestion queue, inline agent questions, capability-scope popover,
  and a steer composer. The transcript defaults to a **focus** view (answers
  only); a toggle shows the full agent work. One person holds the **driver
  seat** (steer/answer/cancel); others can request or be handed it.
- **Agents** (`components/AgentsSurface.tsx`, `/agents`) — every session across
  the workspace, grouped Pinned / Needs you / Active / Recent, with search,
  pin/archive actions, and a collapsible archived section.
- **Sessions rail** (`sessions/SessionsRail.tsx`) — per-channel list grouped
  into *Needs you* / *Active* / *Recent*; click to peek a session.

## Markup: review-and-reply on documents

- **Markup editor** (`components/MarkupPane.tsx`, `markup/MarkupEditor.tsx`) —
  open a structured agent response or markdown artifact in a full-screen
  editor, add tracked changes and comments (CriticMarkup), then either **send
  to the agent** as a steer or **reply in thread** with the marked-up doc.
  Marked-up docs render in the transcript as review cards
  (`components/MarkupSteerCard.tsx`), with a divergence banner and version
  history; **Apply with agent** (`components/ApplyMarkupMenu.tsx`) hands the
  markup to a running session or spawns one to apply it.

## The Work drawer

Everything a session produced, behind one drawer (`sessions/WorkDrawer.tsx`),
opened from the output strips under the transcript and following
peek → pin → detach. Tabs (empty ones hide):

- **Conflicts** (`sessions/ConflictSurface.tsx`) — appears only when two actors
  edited the same artifact concurrently; shows base/left/right (jj-style, both
  sides preserved) and lets you resolve.
- **What changed** (`sessions/WhatChangedSurface.tsx`) — files the agent edited
  (collapsible diffs) plus the gallery of captured artifacts (one tile per
  path, newest-wins, version count).
- **What it ran** (`sessions/SideEffectsSurface.tsx`) — the agent's
  side-effects (network / package / git / filesystem / process / shell) with
  risk badges.
- **Files** (`sessions/FilesHub.tsx`) — folder-aware browser of the session's
  captured files, with scratch/deleted toggles and version history.
- **Published apps** (`sessions/AppsSurface.tsx`) — app bundles under
  `shared/apps/…`: publish, launch, and preview in a sandboxed iframe.

A **detached work tab** (`sessions/SessionWorkPage.tsx`, `/s/:id/work/:slug`)
renders any one of these full-page, folding the same live session stream.

Artifact roots are path-scoped: session-private scratch under
`scratch/<session-id>`, workspace/global work under `shared/global`, app bundles
under `shared/apps`, and channel work under `shared/channels/<channel-id>`. The
active channel is writable for a session; other readable channels are browsable
context, not write targets.

## Settings & connectors

- **Settings** (`components/SettingsSurface.tsx`, `/settings[/:section]`) — a
  routed full surface with sections: Appearance (theme, accent, text size, high
  contrast, motion), Notifications (device permission, message/agent/call
  scopes), Connections, Agents, About. Synced to the server across devices.
- **Connectors** (`components/GitHubConnectionDialog.tsx`,
  `components/ClaudeConnectDialog.tsx`, `components/CodexConnectDialog.tsx`) —
  connect GitHub identities for repository access and personal Claude Code or
  Codex subscriptions so sessions bill to them instead of the workspace
  default.

## Platform coverage

| Area | web | desktop | mobile |
|---|---|---|---|
| Chat (channels, threads, DMs, reactions, mentions) | ✓ | ✓ | ✓ |
| Voice (calls + voice messages) | ✓ | ✓ | ✓ |
| Agent sessions (spawn, steer, seat handoff) | ✓ | ✓ | ✓ |
| Attention / Files / Agents / Search surfaces | ✓ | ✓ | ✓ (tabs) |
| Work surfaces (changes / side-effects / files / conflicts) | ✓ full drawer | ✓ full drawer | simplified sheets |
| Markup review | ✓ | ✓ | ✓ (embedded editor) |
| Settings & provider connectors | ✓ | ✓ | ✓ |
