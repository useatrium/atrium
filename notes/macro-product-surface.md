# Macro — Full Product-Surface Reference

> Source: a thorough crawl of **https://docs.macro.com** (via the machine-readable index at `docs.macro.com/llms.txt`, ~55 pages) on 2026-06-22. Compiled for an Atrium "borrow-from" evaluation. Doc text was extracted through a small summarizing model, so exact feature *names* are faithful but a few labels are paraphrase — the live `.md` pages are the final authority.

---

## 1. What Macro is

**Positioning:** "An extremely fast, unified interface for all your work, all linked together in one database." A single workspace that replaces Superhuman (email) + Slack (chat) + Notion (docs) + Linear/ClickUp (tasks) + Google Drive (files) + Zoom (calls) + a CRM — explicitly pitched against "Notion Balkanization" / best-of-breed tool sprawl, designed "like an iPhone, as a single ecosystem."

**Tech stack:**
- **Frontend:** SolidJS. **Backend:** Rust. Native mobile shell via **Tauri**.
- **Collaboration substrate:** **Loro CRDTs** running over **Cloudflare Durable Objects**; multiplayer presence cursors, offline-first with sync-on-reconnect.
- **Search:** OpenSearch (v2 parent/child indexing for docs/chats/call-records), claims **sub-50ms** unified search.
- **Infra:** AWS, SOC 2 Type II audited; sublicenses LiveKit (calls), FusionAuth (auth), PostHog (analytics, via privacy proxy).

**Company/business:**
- Founder/CEO **Jacob Beckerman**. Built originally for a Series A startup's internal use.
- Raised **~$30M Series A led by a16z** (BoxGroup, 3kVC participating).
- **Open source, "not open core"** — monorepo at `github.com/macro-inc/macro`. License history: AGPLv3 → **BSL 1.1 (March 2026)** → back to **AGPLv3 (May 31, 2026)**. Current = AGPLv3 copyleft; non-AGPL derivatives need a commercial license.
- Self-hostable (AGPL), but hosted version required for iOS app + integrations (Gmail, GitHub). HIPAA/FedRAMP via `self-host@macro.com`.

---

## 2. The architectural core — one database, "everything is a block"

This is the heart of the product and the part most worth studying. Three primitives — **Blocks**, **Mentions**, **Properties** — plus a **channel-derived permission model**, all over a single database with one search index and one inbox.

### 2.1 Blocks
"Blocks are at the core of Macro's philosophy. They are designed to work together like legos." Every entity is a typed block in one DB. Type identifiers:

`md` (documents) · `email` · `channel` · `chat` (agents) · `automation` · `project` (tasks) · `contact` (CRM) · `company` (CRM) · `call` · `canvas` · `code` · `image` · `video` · `pdf` · `unknown` (fallback)

Block capabilities that come "for free" because everything is a block:
- **On-hover previews** of any @mentioned block across all markdown surfaces.
- **Embeds** — most blocks embed read-only into docs ("Convert to embed"); embeds do *not* grant permissions (unlike channel mentions).
- **References panel** — automatic backlinks: every place a block is mentioned/embedded.
- **Unified share dialog** — owner / editor / commenter / viewer + public link.
- **Unified search index** + **unified inbox** spanning all block types.

### 2.2 Mentions (the graph edges)
"Mentions are how blocks reference each other across the workspace." Type `@` in any rich-text surface → autocomplete → renders a **live inline pill carrying the target's current metadata** (e.g. a task pill shows live status + priority). Recorded as backlinks in the target's References panel.

- **Mentionable:** people (name/email), documents, files, tasks, blocks, contacts/companies, channels, threads/messages, dates (date picker). Special: `@here` (ping participants), `@Macro` (invoke the agent inline).
- **Context-dependent semantics** — the clever part:
  - **In channels:** mention auto-shares the item with all channel members; access flows through as members join/leave.
  - **In email:** mentioning a person adds them to CC; renders as a plain hyperlink in external clients.
  - **In docs/tasks body:** creates a link but does *not* notify or share (docs are unfinished when mentions are added).
  - **In comments:** *does* notify.
  - **For agents:** inserts a pointer the AI can read; agent inherits the user's permissions (cannot reach restricted content). Recommended when you already know what the agent should look at.

### 2.3 Properties (the typed attribute layer)
One unified property system across all entity types. Types: `STRING`, `NUMBER`, `BOOLEAN`, `DATE`, `SELECT_STRING`, `SELECT_NUMBER`, `ENTITY` (typed ref to User/Company/Contact/Document/Project/Channel/Chat/Task/Thread), `LINK`.

- Classification: **system** (built-in, non-removable, e.g. task Status) · **custom** · **metadata** (hidden from main views).
- **Pinned** properties surface as pills/chips on cards & in lists; unpinned stay hidden.
- Three editors: inline (click-to-edit), popover, modal (batch).
- Default props per type — Tasks: Status, Priority, Assignees, Due Date, Parent/Subtasks, Depends On, Effort, Story Points, Relevant Documents. Docs: Owner, Folder, timestamps, linked Task, urgency. CRM: Email, Name, Company, interaction timestamps, Domains, Email Sync.
- **Agent-readable/writable** via MCP tools `GetEntityProperties` / `SetEntityProperty` / `ListEntities`.

### 2.4 Permissions — channel-membership-derived
The standout permission idea: **access is determined by channel membership, not per-file ACLs.** "When you mention something it is shared with all members of the channel." Add someone to a channel → they get access to everything mentioned there; remove them → access revokes. Plus an explicit owner/editor/commenter/viewer share dialog and public links for the cases that need it. Team auto-sharing exception applies to **Tasks, Emails, Calls**.

### 2.5 Window manager — "Splits"
Macro ships its own tiling window manager (desktop only):
- `cmd+\` new split · `shift+h`/`shift+l` focus left/right · `shift+escape` maximize · `cmd+escape` close.
- Each split keeps **independent navigation history** (`opt+[` / `opt+]`).
- `shift+enter` / `shift+click` opens a mention or list item in a new split (e.g. inbox left, doc right). Number of splits scales with monitor size/zoom.

---

## 3. Product surfaces (the blocks)

### 3.1 Email — "keyboard-driven email with Gmail sync"
- **Client, not a server** — syncs Gmail / Google Workspace (mail stays in Gmail). **Multi-account unified inbox**; pick sending address at compose. Outlook + custom IMAP/SMTP planned.
- **Signal vs. Noise** filtering: Signal = important AND not shared by someone else; Noise = newsletters/promotions/routine. Bi-directional recategorize via right-click; per-sender block/filter.
- Full client: draft/send, forward, cc/bcc, reply-to-thread, **scheduled send**, **undo send** (configurable window), templates, HTML body, **Calendar tab/view**, email digests.
- **Share threads into channels** (view-only via share; forward to enable replies — asymmetric permission).
- @mention people → adds recipients; @mention docs → inserts link with auto-permission update.
- Shortcuts: `c e` draft · `j`/`k` nav · `e` archive.

### 3.2 Channels — primary comms hub
- Organize by topic/project/team; add members by email (non-users get notification emails).
- **Threaded inline replies** (positioned as quieter/cleaner than Slack threads); reactions; typing indicators; presence.
- Unified rich-text editor (bold/italic/code/lists) + full markdown; message editing with "edited" indicator + preserved history, **no re-notify on edit**.
- Drag-drop attachments auto-import to file storage with inline previews.
- **`@Macro`** agent inline (summarize thread, answer workspace questions); date mentions (`@tomorrow`, `@next week`); `@here`/`@team` groups.
- Shortcut: `c m` create channel.

### 3.3 Tasks — "less ceremonious than Linear"
- Status (In Progress / In Review / Done), priority, assignee. **Deliberately minimal metadata** — cycles/points exist but are discouraged by default.
- Inline task creation from emails/channels via hover action; @mention tasks anywhere.
- **GitHub auto status sync:** branch created → In Progress; PR opened → In Review; merged → Done. PRs show title/number/diff stats on the task; `shift+cmd+b` copies a pretty branch name.
- **Grid view** with sortable headers; task discussion threads; comment notifications.
- Shortcut: `c t`.

### 3.4 Docs — markdown-native collaborative
- `c d` create; **flat (non-nested) docs** in folders (contrast Notion hierarchy); tags for DB-like filtering.
- Full block editor: H1-3, lists/checklists, quotes, code (Prism, 15+ langs), tables, dividers, images/video, **KaTeX math**, inline formatting, `:emoji:`, markdown autoformat, drag-to-reorder, **regex find & replace**, slash menu (`/`), snippets (`;`).
- **Real-time co-edit** (Loro CRDTs + Durable Objects, offline-capable). Inline **anchored threaded comments** (reply/resolve/draft). **Full version history with time-travel** + **fork any past version** into a new doc.
- **Properties panel** (owner/folder/timestamps/urgency/task link), pinnable as pills, optional YAML front-matter toggle, live word/char count.
- Sharing: owner/editor/commenter/viewer, external by email, **public link** (no login), markdown export.

### 3.5 Canvas — infinite 2D board
- @mention any block onto the canvas as **live pills carrying current metadata** (task status/priority stay current — not static snapshots).
- Shapes, styled text, connectors (straight/curved/stepped), freehand pencil, images.
- Full canvas toolset (`v/h/r/x/p/t` tools, group/z-order/nudge/zoom); **share preserves pan+zoom position**; canvases are themselves @mentionable.

### 3.6 Calls — native video (LiveKit)
- Start from calls tab or a channel; participants notified.
- **Auto recording + transcription + AI summary**; speaker diarization, custom speaker overrides, noise suppression, background blur/image.
- **All team calls auto-added to the calls tab** regardless of attendance; **default-shared to team memory** with a per-call opt-out toggle (→ personal memory only).
- Search/summarize transcripts from the calls tab; native iOS **CallKit** (flagged).

### 3.7 Folders / File storage
- Stores md, PDF, images, video, code, canvases. **Auto-ingests** channel attachments + email attachments. Fully searchable.
- Same owner/editor/commenter/viewer permission tiers. `c f` create, `m` move-to-folder.

### 3.8 CRM — auto-built from email
- **Zero manual entry:** contacts auto-created when team emails externals; **companies grouped by email domain**; generic vendor domains filtered out; first/last interaction tracked.
- **Auto-enrichment:** name, description, logo, website, industry, headcount, funding, location, socials.
- Views: Companies sidebar; company page = domains + contacts + threads; **Team** tab (all team comms with account) vs **Me** tab; per-record discussion thread.
- **Email Sync** toggle per company (team-visible vs private); admins can hide records.
- Records are **blocks** (mentionable) and feed **team memory** for agents.

### 3.9 Unified Inbox — workspace-wide "inbox zero"
- Aggregates emails (all accounts), channel/DM messages, agent completions, doc-comment @mentions, assigned tasks, shared files — replaces "checking 7+ apps."
- **Signal / Noise** tabs. Superhuman-style keys: `g i` open · `j/k` nav · `space` split-preview · `enter` fullscreen · `shift+enter` new split · `e` done · `shift+↓` multi-select then `e`.

### 3.10 Unified Search
- One index across email, tasks, docs, call transcripts, agents, files; sub-50ms. Quoted exact-phrase; type filters; @mention to scope to a person.
- Agents use the **same search index** as manual search. `/` search · `cmd+k` go-to-by-name · `l/h` expand/collapse preview.

### 3.11 Snippets — reusable text, `;` trigger
- Type `;` in any markdown surface to insert saved content (full markdown). Works in docs, tasks, messages, canvas text, **agent instructions**. **Live-editing propagates** to future insertions. Personal by default; "Share with team" toggle. `c s` create.

### 3.12 Unified Memory (cross-cutting)
- Persistent **personal + team memory** across mail/messages/tasks/docs/calls/files/canvas/PRs/MCP connectors — explicitly *not* single-conversation chat memory.
- **Nightly refresh cycle** pulls from daily activity; agents auto-retrieve context.
- Two tiers (personal vs team) with sharing rules: tasks default team-visible, calls team-shared (opt-out), email auto-shared by context.

---

## 4. AI / Agents / MCP — the center of gravity

### 4.1 In-product agents
- Chat (`c a`) with full-workspace context ("what's the latest on the launch?" → synthesizes email/messages/tasks/docs/call transcripts). Persistent chat history, resumable.
- **`@Macro`** in any channel to pull the agent into the conversation as a participant.
- **Automations** — scheduled agent runs (form-based, supports @mentions), results delivered to inbox + agents tab. E.g. daily Signal brief, Friday team recap.
- **Subagents** + scheduled agents (Apr 2026); agent framework on the **RIG** Rust framework (May 2026) with thinking, structured completions, concurrent tool calls.

### 4.2 MCP server — workspace exposed to external coding agents
- **Remote, cloud-hosted** MCP server (no local install). Endpoint: `https://mcp-server.macro.com/mcp` (HTTP transport), **OAuth** browser auth, scoped to the user's permissions.
- Setup: `claude mcp add --transport http macro https://mcp-server.macro.com/mcp` · `codex mcp add macro --url …` · IDE JSON config.
- The **same Rust tool registry** powers both the in-product agent and external clients. Point Claude Code / Codex / IDE at your workspace.
- Also ships **external MCP connectors** (Slack, Notion, generic — flagged) so the in-product agent reaches other tools.

### 4.3 The 16 MCP tools

| Tool | Purpose | Key inputs |
|---|---|---|
| **ContentSearch** | Full-text search inside body of docs/emails/messages | `entityTypes[]`, `query` |
| **NameSearch** | Metadata search by title/subject/participant (not body) | `entityTypes[]`, `name` |
| **ListEntities** | List/discover entities w/ filter + sort | `includeTypes[]`, `sortBy` (recently_viewed/updated/created) |
| **GetEntityProperties** | Read an entity's property set + definition ids | `entity_id`, `entity_type` |
| **SetEntityProperty** | Update one typed property | `entity_id`, `entity_type`, `property_definition_id` + a typed value |
| **ReadContent** | Full document content | `documentId` |
| **ReadMetadata** | Document metadata | `documentId` |
| **CreateDocument** | Create plaintext doc; `isTask` flag (md only) makes it a task | `documentName`, `fileContent`, `fileExtension`, `isTask` |
| **GetThread** | Recent messages in an *email* thread | `threadId`, `limit` |
| **ReadThread** | Read across channels/chats/threads; batch + time-windowed | `contentType`, `ids[]`, `messagesSince` (ISO8601) |
| **SendEmail** | Actually sends (not draft); threads if given parent | `to[]`, `subject`, `body`, `cc[]`, `bcc[]`, `replyingToId` |
| **UpdateThreadLabels** | Add/remove an email thread label | `thread_id`, `label_id`, `add` |
| **bash_code_execution** | Run bash in a sandbox | `command` |
| **text_editor_code_execution** | view/create/str_replace files | `command`, `path`, `file_text`/`old_str`/`new_str` |
| **web_fetch** | Fetch + extract a URL | `url` |
| **web_search** | Web search | `query` |

**Key design notes:**
- **Unified entity model** — one (id + type + properties) abstraction instead of per-object APIs, so the same get/set/list triad drives docs, emails, channels, tasks.
- **Two search axes** — ContentSearch (body) vs NameSearch (name/metadata).
- **Tasks ARE documents** — a task is a markdown doc with `isTask=true`; no separate task object.
- **Agent runtime bundled** — bash sandbox + text-editor + web tools shipped alongside workspace tools.
- Docs are auto-generated and thin: no return/response schemas documented (left to runtime discovery via `llms.txt`).

### 4.4 Agent recipes (shipped use-cases)
Daily Inbox Brief (scheduled) · Project Status On Demand · Weekly Team Recap (→ `@#general`) · Turn Call Into Tasks · Draft Replies in Your Voice · Answer Questions Inside a Channel (`@Macro`) · Import From Another Tool (Notion via Connectors) · **Use Your Workspace From Claude Code** (the MCP recipe: find task → read linked channel → set status In Review → post summary comment).

---

## 5. Platform, accounts, integrations

- **Platforms:** Web (no install, full splits + keyboard); iOS (App Store, same workspace, *no* splits/shortcuts by design); **Android not yet shipped**; desktop app via Tauri (onboarding "desktop launch step" Apr 2026).
- **Auth:** Google sign-in (Gmail / Workspace).
- **Teams:** 3 roles — **Member** (sees shared tasks/calls/CRM) → **Admin** (+ CRM email-sync toggle, hide records) → **Owner** (+ invite/remove, can't remove self). Default on join: tasks org-visible, calls recorded+shared, customer emails sync to CRM. Snippets stay private unless shared.
- **Integrations:** GitHub (unified OAuth app, webhook parsing, PR↔task, status sync, branch-name gen) · Gmail/Workspace · MCP connectors (Slack, Notion, generic) · Notion/ClickUp/Linear import (agent-driven + Linear CSV) · LiveKit calls · cal.com (support scheduling).

---

## 6. Pricing & business model

| Plan | Price | AI | Tool calls | Storage |
|---|---|---|---|---|
| **Free** | $0 | Fast model only | Limited | 5 GB |
| **Premium** | **$40/mo** | All models | Unlimited | 1 TB |

- Stripe billing. Free tier appends "Sent with Macro" to outgoing email.
- **No free team tier** — every team member needs a paid Premium seat; invites are seat-gated.
- Same per-seat price solo or team. Self-host free (third-party services need own licenses).
- Revenue = hosted SaaS + commercial licensing for non-AGPL derivatives. Pricing was actively restructured Mar–May 2026.

---

## 7. Trajectory & velocity (changelog)

Auto-pulled from GitHub Releases, versioned `vYYYY.M.D.patch`, **~3–4 point releases/day** — a small, very fast team lighting up one competitor's category per month:

- **Dec 2025:** task entity + Properties system + Gmail/email foundations + Signal/Noise.
- **Jan 2026:** AI tools explosion (code-exec, web-fetch, Anthropic server-side tools), iOS v1, email maturity (undo send, scheduled drafts), Tailwind v4, service consolidation.
- **Feb 2026:** notification state machine, search quality, channels re-architecture ("hex channels" crate) begins, GitHub linking begins.
- **Mar 2026:** new channels UI, **GitHub GA**, **pricing tiers + team features**, agent memory + MCP server, sidebar redesign. License → BSL.
- **Apr 2026:** **video calls pillar** (recording/diarization/summary), **scheduled agents + subagents**, teams admin (role changes), entity-access crate.
- **May 2026:** **agent framework → RIG crate** (concurrent tools, external MCPs Slack/Notion), **Gmail multi-inbox**, **CRM build-out**, channels migration completes, search v2 indexing, new pricing + AI tier, native iOS CallKit.

**What it reveals:** AI agents are the strategic center; aggressive surface expansion; monetization matured late; heavy parallel backend modernization (RIG agent crate, entity-access crate, OpenSearch v2, hex-crate channel rewrite).

---

## 8. Cross-cutting design principles (the "philosophy")

1. **One database, everything is a typed block** — uniform previews, embeds, backlinks, search, inbox, permissions for free.
2. **Mentions as typed graph edges** with **context-dependent share/notify semantics** (channel = share, email = CC, doc body = link-only, comment = notify).
3. **Live pills** — references render current metadata, not snapshots.
4. **Permissions derived from channel membership**, not per-file ACLs.
5. **Keyboard-first, vim-flavored, Superhuman-inspired** — consistent grammar: `c`+key creates everything, `j/k/h/l` + `gg`/`shift+g` navigate, `e` = done/edit, `/` + `cmd+k` search, `;` snippets.
6. **Built-in tiling window manager (splits)** with per-split history.
7. **Auto-ingestion everywhere** — email/channels feed Folders; email feeds CRM; daily activity feeds nightly memory refresh.
8. **Two-tier memory (personal/team)** with opt-out sharing defaults.
9. **AI as a first-class peer to the data model** — same entity/property model the UI uses is the MCP surface; in-product agent and external coding agents share one tool registry.
10. **Speed as a feature** — Rust + Solid, sub-50ms search, CRDT real-time, instant everything.

---

## 9. What's potentially relevant to Atrium (raw notes, pre-discussion)

Atrium is an agent↔human shared workspace (channels, sessions, docs/notes, artifacts, agent sessions, sync). Macro overlaps heavily on the *human-collaboration substrate* side. Candidate ideas to borrow or contrast:

- **Unified "everything is a block" + typed-properties + mentions model** vs. Atrium's current per-surface schema. Could simplify Atrium's data layer and unlock backlinks/previews/embeds uniformly.
- **Channel-membership-derived permissions** — elegant alternative to per-resource ACLs; Atrium already leans on channels.
- **MCP server exposing the workspace to coding agents** with a *unified entity/property tool registry* + "tasks are documents" + two-axis search — directly relevant to Atrium's agent-data architecture and the existing `/atrium` projection/MCP ambitions.
- **Live pills carrying current metadata** for agent/session/artifact references in chat and docs.
- **Unified memory (personal/team, nightly refresh)** — compare to Atrium's session-records/change-feed; Macro's "team memory as agent context" is a framing Atrium could adopt.
- **Signal/Noise unified inbox** + Superhuman keyboard grammar — UX patterns for Atrium's notification surface.
- **Automations / scheduled agents → inbox** — overlaps Atrium's cron/loop/scheduled-agent surface.
- **Snippets** (`;`, live-propagating, agent-instruction-aware) — cheap high-value addition.
- **GitHub auto-status-sync via branch lifecycle** — Atrium already has GitHub rendering endpoints; this is the task-state half.
- **Open-source AGPL + self-host posture** — relevant comparison for Atrium's deployment/hosting strategy.

Things to be wary of borrowing: the breadth (Macro is a do-everything suite; Atrium is more focused), the closed-hosted-required-for-integrations tension, and the flat-docs / minimal-task-metadata opinions that may not fit Atrium's use.
