# Atrium architecture — the agent workspace, in depth

How dozens of AI coding agents — and the humans supervising them — share files,
chat in the same threads, and reconcile their edits, when every agent runs locked
inside a sandbox that nothing is allowed to connect into.

The [README](../README.md) gives the short version of this story. This document
is the deep dive: the data model, the sandbox filesystem, the capture and sync
mechanics, and the honest list of what's still open. It's a living design
document; details change as the build proceeds.

## The problem

Atrium runs teams of AI agents working in parallel under human oversight. A
realistic session isn't one agent in one repo — it's a dozen agents and several
people, chatting in shared channels and touching an overlapping pool of
documents, datasets, notebooks, and code. That creates four requirements that
pull against each other:

- **Durability** — an agent's work must survive a crash, a pause, or the sandbox
  being destroyed.
- **Freshness** — when a teammate (human or agent) changes a shared file, others
  should see it quickly, not discover it hours later.
- **Conflict-safety** — if two actors edit the same file at once, neither edit
  may be silently thrown away.
- **Agent UX** — agents should just write files and post messages. No "remember
  to commit," no version ceremony. The plumbing happens underneath them.

**The constraint that shapes everything:** each agent runs in a hardened,
*no-ingress* sandbox — non-privileged, all Linux capabilities dropped, and,
critically, nothing can open a connection into it. The sandbox can only reach
out. That single rule rules out every off-the-shelf file-sync tool (Syncthing,
Mutagen, rsync daemons, webhooks), because they all need to connect in. So all
synchronization has to be either sandbox-initiated or driven from outside the
sandbox entirely.

## How it fits together

Three pieces make up the system. The **clients** (web, desktop, mobile) are what
people look at. The **Atrium server** is the hub everything flows through — the
database, the file storage, and the live connections to clients. And **Centaur**
(vendored in [`centaur/`](../centaur/)) is the separate runtime that actually
runs the agents, in sandboxes, on its own machines.

The Atrium server is a single application process wearing several hats: it
serves the REST API (auth, channels, messages, sessions, artifacts, calls,
uploads), runs a live-update hub over WebSockets so clients see new messages
instantly, streams each agent's output to the browser, and runs background
workers (speech-to-text, file offload, garbage collection). It talks to Centaur
over plain HTTP — outbound only, matching the no-ingress rule.

Keep this split in mind for everything below: **Atrium is the durable,
human-facing system** (database, storage, UI, coordination). **Centaur is the
disposable, agent-facing runtime** (sandboxes, execution) — it holds only
ephemeral staging, which is exactly why Atrium copies bytes out before Centaur's
retention evicts them. The interesting engineering lives on the seam between
them: getting work safely out of the disposable side and into the durable side.

## The collaboration spine

Before any agent runs, there's the human layer: people talking in channels,
replying in threads, reacting, and spawning agents. In Atrium this isn't a pile
of separate tables — it's **one append-only event log** that is the source of
truth. A message posted, a message edited, a reaction added, an agent spawned, a
question answered — each is an event appended to the log. The channel list, the
unread counts, the "who's online" are lightweight views computed from the log,
not the truth themselves.

Editing a message doesn't mutate it in place — it appends an "edited" event that
supersedes the original; a delete is a tombstone event. Reactions are
added/removed events whose net is summed on read. Nothing is destructively
overwritten, so the full history is always reconstructable. (The one exception:
presence and typing indicators are ephemeral — they live only in the live-update
hub's memory, never in the log.)

**There are actually two logs.** The chat spine is one. Each agent also emits a
raw, harness-specific transcript (its own step-by-step trace), mirrored into a
separate per-session log. The server's tailer reads that raw stream and folds
the meaningful moments (a message to show, a status change, a captured file)
into the chat spine — so humans see a clean conversation while the full raw
trace is preserved for resume and audit.

**Sessions are the bridge.** A session is an agent run and a pane in the
workspace at the same time. Each session belongs to a channel, threads its
activity under a root message, and maps one-to-one to a durable agent thread in
Centaur. Humans collaborate on a running session by steering it and answering
its questions — and those interactions are themselves recorded, so the
back-and-forth of supervising an agent becomes part of the durable record.

**Control plane vs. data plane.** The collaboration spine (the event log) is the
control plane — coordination, conversation, who-asked-for-what. The artifact
ledger (next sections) is the data plane — the actual files being produced and
versioned. Humans and agents write to both, and the two reference each other:
an artifact knows which session produced it; a session lives in a thread in a
channel.

## Three agent-data shapes

What agents produce splits into three shapes, and trying to force them into one
consistency model is the classic mistake:

| Shape | Examples | Backing | Merge model |
|---|---|---|---|
| **Logs** | conversation transcripts, the agent's step-by-step trace | Postgres event log → sealed S3 segments | Append-only — never merged |
| **Artifacts** | documents, datasets, reports, notebooks, images | Content-addressed blobs (S3) + version ledger (Postgres) | Per-file merge — versioned, conflict-aware |
| **Code** | source repositories | Git, on the existing forge | Git — we coordinate around it, we don't reinvent it |

Logs are easy (just append). Code is solved (git already exists, and agents
already know it). Artifacts are where the real work is: files that both humans
and agents edit, that need history, that need to be shared across sessions, and
that need a sane answer when two edits collide.

## The content-addressed ledger

The artifact store borrows git's core idea: **immutable content + moveable
pointers**. Every version of every file is stored once, addressed by the SHA-256
of its bytes (identical content is automatically de-duplicated). An "edit" never
overwrites anything — it writes a new blob and advances a pointer. Old versions
are always retrievable.

| Layer | Lives in | Why |
|---|---|---|
| Immutable file bytes | S3, keyed by content hash (`cas_blobs`) | Object stores are cheap and effectively infinite, but can't do atomic compare-and-set |
| Version chain, pointers, conflict state | Postgres | A transactional database can do atomic updates — so the moveable parts live here |

**The twist: conflicts are state, not errors.** Most version systems, when two
edits collide, either block ("merge failed, fix it before you continue") or
silently pick a winner (last-write-wins). Both are wrong for autonomous agents:
blocking stalls a fleet, and silent loss is unacceptable. Atrium follows the
model pioneered by the [Jujutsu](https://github.com/jj-vcs/jj) version-control
system: a conflict is a first-class, recorded version that contains both sides.
The pointer still advances — nothing blocks — but the new "latest" version is
explicitly marked conflicted and carries both competing edits. A human or agent
resolves it later, as a normal follow-up edit. Nothing is ever lost, and nothing
ever stalls.

**Why build this instead of buying it.** We evaluated the obvious off-the-shelf
option (lakeFS, "git for data") by actually running it. It only does whole-file
merges — a collision returns an error or silently discards a side — and its
per-tenant access control is paywalled. The conflict-as-state model and tenant
isolation we need are exactly what it can't give. jj has the right model but no
open-source cloud backend exists. So the ledger is our own — but it's small:
content-addressed blobs and a version chain are well-understood, and the bytes
plumbing reuses infrastructure Atrium already runs.

## The agent's workspace

Inside the sandbox, the agent's **home directory is the workspace**. Underneath,
the shared-artifact roots sit on an overlay filesystem with a read-only *lower*
layer (hydrated shared files) and a private, writable *upper* layer (this
agent's changes). A write copies the file up into the private upper — the
shared base is never touched.

This buys two things for free. First, the agent gets full POSIX behaviour —
real renames, locks, partial writes — with no "permission denied" surprises,
because every write lands in its own private layer. Second, and crucially,
**the upper layer is exactly the set of changes the agent made**. There's no
need to scan the whole tree to find what changed; the filesystem already
separated it out.

**A deliberate scoping trick:** the overlay covers only the shared-artifact
folders. Big, noisy directories — `node_modules`, virtualenvs, build caches,
and git repos — are mounted as separate volumes, so they structurally can't
bloat the change-set or get captured by accident. A dependency install simply
isn't in the layer we watch.

What the agent actually sees:

```
~/                               # WRITABLE — the workspace (captured)
  shared/…  scratch/<session>/   # shared artifacts + private scratch
  repos/<owner>/<repo>/          # code — git owns it (separate volume)
  node_modules/ .venv/ .cache/   # dependencies (separate volumes; never captured)

/atrium/                         # READ-ONLY — the world (one shared copy per node)
  README                         # "here's how to read this tree"
  chat/…                         # team chat — appended live as people talk
  sessions/<id>/…                # other agents' transcripts, summaries, status
  artifacts/…                    # every shared file, latest version, browseable
```

The home directory is *my work*: writable, and the only thing capture watches.
`/atrium` is *the world*: read-only context — the team's chat, what sibling
agents are doing, and every shared artifact at its latest version. Splitting
them means the agent never confuses its deliverables with ambient context, and
capture has exactly one place to look. Alongside the mounted tree sits a small
query tool (`atrium search · read · log`) for targeted or fresher-than-the-mount
lookups. Browse with the filesystem; reach with the tool.

The context tree is mostly append-only (chat and transcripts only ever grow), so
keeping it fresh is just appending lines to the tail of a file — no merge, no
conflict, within seconds. And because many agents on one machine see the same
context, `/atrium` is materialized **once per machine** and shared into each
sandbox, which is what makes a workspace-wide view affordable.

The whole agent UX, in one line: *read files in `/atrium`, do work in `~`, talk
in the thread.* No commit ceremony, no sync protocol, no special inbox to poll —
steers from humans simply arrive as messages in the conversation the agent is
already having.

## How a container runs

When someone (or another agent) starts a session, Atrium asks Centaur to bring
up a sandbox and drives it through a fixed lifecycle. Each agent maps to a
durable thread on the Centaur side — a stable handle that outlives any single
turn, which is what makes pause and resume possible.

> ① **Spawn** (create the session + sandbox) → ② **Execute** (run one agent
> turn) → ③ **Mirror** (stream output back) → ④ **Capture** (files → ledger) →
> ⑤ **Offload** (bytes → durable S3)

- **Spawn** — Atrium writes the session record and a "session spawned" event,
  then asks Centaur to create the sandbox for that thread. (Spin-up is warmed in
  layers — pre-booted sandbox pool, pre-baked toolchain image, per-machine repo
  mirror, and Atrium's content-addressed dependency/build cache; see
  [`centaur/ATRIUM_FORK.md`](../centaur/ATRIUM_FORK.md#sandbox-warming--cold-start-lifecycle).)
- **Execute** — a message is posted to the agent and a single turn begins.
- **Mirror** — Atrium tails the agent's raw output stream and, frame by frame,
  records it to the per-session log and folds the meaningful parts into the chat
  spine and the live-update hub. This is how a running agent's work shows up in
  the UI in real time.
- **Capture** — when the agent produces a file, a new version is recorded in the
  ledger.
- **Offload** — a background worker copies captured bytes out of Centaur's
  ephemeral staging into Atrium's durable S3, before Centaur's retention can
  evict them.

A turn can run for a long time; pausing tears the container down but keeps the
thread, so a later turn resumes rather than starting over. A finished session
reopens for another turn when someone replies.

**The security model, in brief.** The sandbox is no-ingress and the agent
process is hardened (non-root, no privileged capabilities). Secrets never sit
inside the sandbox: when an agent needs to reach an external service, its
traffic flows through a credential-injecting proxy that adds the right token on
the way out — so the agent can use a service it can never read the keys for.
Anything that needs privilege (mounting the overlay, reading the change-set,
refreshing files) is done by the machine, outside the hardened agent — which is
the basis for how capture and sync work.

## Capture — getting changes out

The tension: we want to watch the agent's changes and ship them to durable
storage — but the sandbox can't run privileged watchers, and nothing can connect
in to read them out.

The answer is to move the work out of the agent and onto the machine. A
privileged **node daemon** (`centaur-node-sync`, one per host, shared by all the
agents on it) reads each agent's overlay upper layer directly from the host
side:

> upper layer (only the changed files) → node daemon (reads, interprets,
> hashes) → S3 + ledger (new version recorded)

Because it reads the change-set rather than the whole tree, the work is
proportional to what actually changed, not the size of the workspace. Because
there's one daemon per machine rather than one watcher per agent, it scales
with the number of hosts, not the number of agents. The daemon understands the
overlay's encoding for deletes and renames, so those are captured faithfully —
and since it's trusted infrastructure, it can stream large files straight to
S3. The agent never runs a watcher and never opens an inbound port.

## Sync — getting changes in

The hard direction is inbound. If a teammate edits a shared file, a running
agent is still looking at the version it started with. Left alone, the agent
does work on stale data and never finds out — and analysis of busy shared
folders shows this "acted on stale data, no signal" case is the quiet, common
danger, more so than outright collisions.

Because capture already lives on the node, inbound sync lives there too — and
the agent does nothing. The same daemon that reads the workspace also writes to
it, through the same shared mount the agent's own edits travel through:

- it follows the ledger for new versions of the files the agent is using;
- if the agent hasn't touched a file, the new version is written straight into
  the live workspace;
- if the agent also edited it, the three-way merge runs — clean merges land
  silently; a genuine collision becomes a recorded conflict version, surfaced
  as a message rather than a failure;
- the read-only context tree (chat, sibling transcripts) stays live by
  appending new events to file tails — append-only data needs no merge at all.

**Why the node does this, not the agent.** An earlier design staged updates
into an incoming folder and made in-container code merge them — but that's a
strange channel for an agent to poll and a protocol for it to run, the opposite
of good agent UX. The only thing inside the sandbox is a lightweight "I'm
between steps" quiesce signal from the harness, so a file never changes in the
middle of the agent reading it — and the agent's model never sees even that.
The result: the agent just finds files fresh, and humans' steers arrive the
natural way, as messages in the thread.

## Durability by content class

The node daemon is a single mechanism, but it routes by content class rather
than forcing everything into the version ledger:

| Content | Goes to | Why there |
|---|---|---|
| Artifacts | the version ledger | edited, versioned, shared — the conflict-aware store |
| Uncommitted code edits | a patch/diff snapshot (no git refs) | keeps work-in-progress durable without touching the repo agents share |
| Logs & transcripts | packed, sealed S3 segments | append-only; needed to resume a session, not to version |

**Design decision: how to keep uncommitted code safe.** The tempting approach —
quietly auto-committing work-in-progress to a hidden git ref — was rejected:
any automated git activity in a repository a fleet of agents shares risks
confusing those agents (unexpected objects, refs, and GC churn). Instead, the
daemon captures work-in-progress as a plain patch/diff snapshot stored as an
artifact. It creates zero git objects or refs the agent can see. The trade-off:
recovery means "re-clone and apply this patch" rather than a native checkout —
an acceptable price for keeping the agent's view of git pristine.

## Build vs. buy

A lot of this resembles problems open-source infrastructure already solved, so
each layer was checked against the off-the-shelf options before building:

- **Buy** — mature libraries adopted directly where they fit: content-defined
  chunking and large-file de-dup layers, log shippers, Parquet for cold
  archives.
- **Borrow** — well-known patterns re-implemented in a few hundred lines where
  adopting the whole product would be overkill: the log-segment + index shape,
  the patch-snapshot idea for work-in-progress.
- **Build** — the parts no product offers: the conflict-state ledger, the
  no-ingress sync, node-side capture, base-layer hydration, and the
  agent-facing policy (scoping, merge rules, filtering).

The headline finding from that survey: no off-the-shelf system does this
combination — no-ingress, large binaries, versioned-with-merge, multiple data
shapes, agent semantics. The universal answer among agent platforms is
"ephemeral sandbox per task + git pull requests"; nobody ships a durable,
shared, conflict-aware workspace store. The integration is the product.

## Scaling to a team

The design was sized for fleet scale (50–200 concurrent agents), and a few
numbers drove the choices:

- **Don't make one storage object per event.** A naive "one object per log
  line" approach would create tens of millions of tiny objects a day and cost
  thousands of dollars a month in request fees. Batching log lines into sealed
  segments before they hit object storage is ~120–300× cheaper.
- **Content-addressing spreads load for free.** Files keyed by hash naturally
  fan writes out across storage partitions, so per-partition write limits are a
  non-issue.
- **Share the context view per machine.** Projecting every session's chat and
  logs into every agent separately would be O(agents²) write amplification.
  Materializing the read-only context once per machine collapses that by the
  number of agents per machine — which is what makes a workspace-wide view
  affordable.
- **Conflicts are real at scale.** On a hot shared folder with dozens of active
  agents, a meaningful fraction of writes overlap with another in-flight edit.
  Conflict-as-state and fast inbound sync aren't over-engineering — they're
  load-bearing once sharing is real.
- **Chunk-level de-duplication is deferred on purpose.** It saves 14–34× on
  big files edited in small increments but almost nothing on ordinary text, so
  it's switched on only when large, churny binaries actually dominate storage —
  and even then by adopting a library, not writing one.

**Tenant isolation.** The node daemon can read every agent's files on its
machine — fine within one team, a real boundary between separate organizations.
The plan for true multi-tenancy is a VM per tenant, so the "can read everything
on the host" power is contained by a hardware boundary rather than a software
policy. This is designed, not yet built.

## Status, limitations, and open questions

This is a design with a working core, not a finished system. Shipped today: the
collaboration spine and chat, the session lifecycle with pause/resume, the
conflict-state ledger with three-way merge, node-side overlay capture, inbound
sync with the live `/atrium` context tree, base-layer hydration, WIP patch
snapshots, the warm-start stack (including the shared dependency/build cache),
and the human-facing artifact surfaces (gallery, Files hub, work drawer,
conflict resolution, and the markup review flow).

Still open, honestly:

- **Stale reads have a window.** Fast inbound sync narrows it to seconds, but
  an agent can still act briefly on data superseded between one refresh and the
  next. The window is small and visible; it isn't eliminated.
- **General human editing is thin.** Humans can browse, preview, resolve
  conflicts, and propose/apply edits through the markup review flow, but
  there's no general click-to-edit on an arbitrary artifact tile yet.
- **Very large files have a ceiling on the sandbox-initiated path.** The node
  daemon can stream big files out, but the streaming/chunking layer for
  multi-gigabyte media is not built.
- **Workspace-wide context needs noise control.** Letting every agent see the
  whole workspace's chat and logs is affordable to store, but noisy to reason
  over. Scoping by channel/topic/recency is a tuning knob, not a solved
  default.
- **Some conflict resolutions are a product call, not an algorithm.** If one
  agent deletes a file while another edits it, should it stay deleted or be
  resurrected? That needs a deliberate UX decision.
- **Multi-tenant isolation is designed, not deployed.** Today's single-tenant
  use doesn't exercise the VM-per-tenant boundary.
- **A privileged node component is a serious surface.** It runs with host
  privileges and reads (and writes) many agents' files — which is exactly why
  the tenant boundary has to be hardware, and why it's treated as trusted,
  audited infrastructure.

Conceptual references: [Jujutsu](https://github.com/jj-vcs/jj)
(conflict-as-state), git (content-addressed storage), lakeFS (evaluated),
Xet (large-file de-dup).
