# Inbound Sync (Track C1) — cross-system spec

> **SUPERSEDED 2026-06-20 by `agent-sync-design.md` §4.** This spec assumed
> *in-container* daemons (an in-sandbox egress-poll + a stdin-poke-as-primary). The
> C4 decision (capture moved to a node-level overlay-upper scan) reframes sync:
> **fetch+stage move to the node** (which has full connectivity — the no-ingress /
> stdin-poke complexity largely evaporates), and only the **checkpoint adopt** stays
> in-container (overlay forbids external layer modification). The mechanism facts
> below (stdin-over-attach, egress-only NetworkPolicy, the grounded verification) are
> still accurate and reused; the *architecture* (where the daemon lives) is replaced
> by `agent-sync-design.md`. Read that first.

Pull a human/other-agent edit of a shared artifact into a **running, no-ingress**
sandbox. This is the gating item for live cross-container collaboration
(`agent-data-architecture.md`), and it's **downstream of the CAS-ledger** (the
ledger is the version source it pulls from). Spec'd before the ledger fan-out so
the ledger is built C1-ready. Grounded in `centaur-wt/integration` (2026-06-19).

> **Design-pass update (2026-06-19)** — three decisions firm up this spec:
> 1. **Live mid-session inbound is IN SCOPE.** The goal is a running agent seeing an
>    edit *within seconds*. The egress-poll daemon (below) is the floor; the stdin
>    poke is the latency cut — now a **target**, not just an optional optimization.
> 2. **The change-feed is workspace/topic-scoped**, not session- or channel-scoped.
>    Shared artifacts live in a `(workspace, fullpath)` namespace (scope = path
>    prefix; `scratch/`=private). The feed keys on the **shared paths a session
>    hydrated**, not on `session_id`. (See `cas-ledger-build-plan.md` §10.1.)
> 3. **Autonomous reconcile = auto-rebase**, not stage-and-wait (see Reconciliation).

## The constraint, and the mechanism reality (corrects the design doc)

Sandboxes are **no-ingress** — nothing dials in. The design doc said invalidation
would "ride the outbound subscribe stream." **There is no such stream.** Verified:
- A running agent's *only* inbound channel is **stdin over the k8s `attach` pipe**
  — `write_input_lines(pipe, lines…)` → `pipe.stdin.lock().send(line)`
  (`centaur-session-runtime/src/lib.rs:3663`, `SessionInputSink =
  FramedWrite<SandboxWrite, LinesCodec>`). The control plane *pushes* lines down;
  the sandbox cannot be dialed.
- The existing "push to a running session" path is `append_messages`
  (`lib.rs:469`) → `steering_input_line` (`lib.rs:3781`), which writes a **typed
  JSON line** carrying `"source":"session.append_messages"`. So typed directives
  over stdin already exist — a new `source` value fits the same shape.
- The sandbox **can egress to api-rs** (that's how `artifact_capture.py` POSTs
  captures out); it cannot reach Atrium S3 directly.

So inbound sync is **not** "hold a stream open." Two viable mechanisms:
- **(Primary) egress-poll inbound daemon** — a small in-sandbox process polls
  api-rs ("what artifacts changed for my session since watermark W?"), GETs the
  bytes, writes them to a **staging dir**. Pure egress, **harness-agnostic**,
  no-ingress-clean. Mirrors the proven `artifact_capture.py` (but inbound).
- **(Optimization) stdin poke** — api-rs writes a `{"source":"artifact.sync",…}`
  line to nudge "pull now," cutting poll latency. Needs the harness (or the
  daemon) to act on the new line → **per-harness work / verification** (see Open
  items). Not required for a correct v1.

**Recommendation: build the egress-poll daemon for C1 v1; add the stdin poke
later as a latency cut.** It avoids per-harness changes and the at-least-once
ordering trap.

### Grounded verification — container comms + file monitoring (2026-06-20)

Two read-only research passes over `centaur-wt/integration` (branch
`atrium/integration`) confirmed the mechanism and sharpened the
exists-vs-net-new boundary. The poke and the daemon are **complementary, not
alternatives**: the poke is a *control signal* (go pull now); the bytes **must**
come over egress regardless — so the daemon (the egress fetcher) is needed either
way, and the poke only removes the *idle polling*, it does not replace the daemon.

**The notify-a-running-container channel EXISTS and is the only one:**
- Sandboxes are k8s `Sandbox` CRs (Deployment-shaped, `spec.replicas`); **pause =
  scale to 0**, not delete (`sandbox-agent-k8s/src/lib.rs:485,512`). Warm-pool
  replenish 5s. Workspace = **`git clone --shared`** one-shot at boot, fresh
  `agent-<ts>` branch (`entrypoint.sh:351`); **no overlay, no workspace PVC**.
- Security posture (the overlay-killer, reconfirmed): `allowPrivilegeEscalation:
  false`, `capabilities.drop:["ALL"]`, `runAsNonRoot:true`, seccomp `RuntimeDefault`
  (`tools.rs:109`). ⇒ **inotify (unprivileged) is fine; `fanotify`/overlay (want
  `CAP_SYS_ADMIN`) are off the table** without a posture regression.
- Inbound transport = **stdin over a held k8s `attach` stream**: api-rs holds
  `pods().attach()` and keeps the write half in a per-sandbox `SessionPipe`
  (`sandbox_pipes: HashMap<sandbox_id, SessionPipe>`, `session-runtime
  lib.rs:57,169`); `write_input_lines` → `pipe.stdin.send(line)` (`lib.rs:3663`).
  Mapping: thread_key → `session.sandbox_id` → `sandbox_pipes[sandbox_id]` → attach.
- **No held outbound/subscribe stream — confirmed.** The only persistent connection
  is the attach (stdin in; stdout/stderr pumped to events); missed-output recovery
  replays **kubelet logs** (`lib.rs:371`), not a stream.
- Egress posture — **default-deny ingress, egress-only** NetworkPolicy
  (`iron_proxy.rs:1112`); egress allowed to iron-proxy, **api-rs on 8000/8080**,
  DNS, optional OTLP. The control plane reaches the container **only** via the kube
  API attach, never a network port.
- Existing api-rs cadences (precedent for our floors): warm-pool 5s; **event-stream
  safety poll 30s** (`EVENT_STREAM_SAFETY_POLL_INTERVAL`, `lib.rs:43`); steering
  startup retry 250ms→15s. Sandbox capture loop = 2.5s.

**Three net-new pieces (the channel is reusable; the message + both endpoints are not):**
1. **A control-line emit path.** Steering today forwards **only `MessageRole::User`**
   — non-user roles are dropped (`lib.rs:3786`). A `source:"artifact.sync"` poke is
   *not* a user turn, so it needs a **new emit path** (not a reuse of
   `append_messages`), else it's dropped or mis-fed to the model as a user message.
2. **An in-container consumer.** The app-server stdin reader handles harness turns,
   not arbitrary control directives → the **harness (or a sidecar daemon) must grow
   a handler** for the new line type. This is the per-harness open risk; the
   egress-poll daemon sidesteps it (it acts on its own poll, needs no poke handler).
3. **The byte transfer.** The attach pipe carries the harness JSON protocol; **bulk
   file bytes have no inbound channel**. A pull must **egress** to api-rs (and from
   there Atrium S3) over the existing proxy allowance — i.e. exactly the daemon's
   egress GET. The poke only triggers it.

**Net:** the Atrium-side push trigger is already wired (`pg_notify('artifact_advanced')`,
`artifact-ledger.ts:202`); the Centaur-side stdin transport already exists. The
net-new is the **dispatcher** (LISTEN→api-rs), a **non-user control-line type +
emit path**, a **harness/daemon consumer**, and the **egress byte-pull** (the
daemon). v1 = daemon-only (poll, harness-agnostic, correct); v1.x adds the poke to
collapse idle poll QPS to ~zero.

## The three components + contracts

### 1. Atrium — ledger advance emitter
When `artifact_pointers('latest')` advances for an artifact whose `session` has a
**live execution** (Atrium already tracks `current_execution_id` + status):
- Emit to api-rs (Atrium → api-rs is a normal server-to-server call; api-rs is
  reachable). Payload: `{ session_id, channel_id, path, artifact_id, seq, sha256,
  size, mime, author }`.
- Cheap to wire: a `LISTEN/NOTIFY` (or outbox) on the pointer-advance write →
  a small dispatcher POSTs api-rs. **The NOTIFY hook is near-free to add in the
  ledger round now** (the dispatcher itself is C1).
- Skip emit if no live execution (the agent will hydrate fresh on next start).

### 2. api-rs — inbound staging + change-feed + byte serve
- **Receive route** (new): accepts the Atrium advance; auth via a shared key.
- **Staging**: either (a) Atrium **pushes the bytes** into a Centaur
  inbound-staging area so the existing GET serve route returns them locally, or
  (b) api-rs **proxies on demand** to Atrium's serve route. *(Byte-path decision
  below.)*
- **Change-feed route** (new): `GET …/inbound-artifacts?since=W` → list of
  `{path, sha, seq, ref}` updated for the session's execution since watermark `W`.
  The daemon polls this.
- **Map** session → live execution (the runtime already holds `sandbox_pipes` by
  execution; reuse for the optional stdin poke).

### 3. In-sandbox inbound daemon
- Poll the change-feed (egress) on an interval (e.g. 5–15 s; tunable).
- For each changed artifact: GET the bytes, write to a **staging path** —
  `~/.atrium/incoming/<path>` (or a sidecar `.atrium-incoming/`) — and drop a
  small marker/note. **Never overwrite the live file under the agent**
  (no-hot-swap rule): notify, let the agent/harness decide to adopt/rebase.
- Advance its local watermark `W`. Idempotent: skip if the staged sha already
  matches what it has.

## Byte-path decision (the one real fork in C1)
- **(A) Atrium pushes bytes into Centaur staging** on advance → daemon GETs
  locally via an existing-style route. Pros: reuses the local serve path, keeps
  sandbox egress unchanged; decouples (Centaur never calls Atrium). Cons: a new
  Centaur inbound-staging table (don't overload execution-scoped `artifact_blobs`)
  + Atrium→Centaur byte transfer. **Recommended** — cleaner isolation.
- **(B) api-rs proxies to Atrium on the daemon's GET.** Pros: no pre-staging, no
  new table; always live. Cons: couples api-rs to Atrium's API + auth; a slow
  Atrium hop in the sandbox's read path.

## Reconciliation — at the ledger, not in the sandbox
The sandbox only *stages* incoming bytes; it never merges. If the agent edits and
later promotes, the **ledger** forks → conflict-state (the `status=conflict` /
`conflict` jsonb path being built in the ledger round). So C1 needs **no merge
logic in the sandbox** — it's a fetch-and-stage + notify. This keeps C1 tractable.

**Autonomous-agent reconcile (design-pass 2026-06-19).** Staging is correct but
*inert* for an agent with no human watching — nothing makes it adopt the staged
file (hand-compute finding 3). Decision: the daemon drops the incoming bytes **plus
a reconcile signal**, and the harness **auto-rebases** (node-diff3) the staged
version against the agent's working copy **at a safe checkpoint** (next read /
between edits — *never splicing into a file mid-write*), continuing with inline
conflict markers + a `status=conflict` version recorded in the ledger. Human-in-app
stays notify-then-resolve (a banner). This is the §10.4 fix; the merge still happens
ledger-side as conflict-state — the agent just adopts it deliberately rather than
blocking.

## What the LEDGER must expose for C1 (build these C1-ready in this round)
1. **A pointer-advance signal** — `LISTEN/NOTIFY` (or an outbox row) on
   `artifact_pointers`/`artifact_versions` writes. *Near-free; add it now.*
2. **Serve-by-`(session,path)@latest` returning `{sha, size, mime, bytes/redirect}`**
   — already in the ledger plan (the serve-by-path route).
3. **A "changed since watermark" query** over `artifact_versions`
   (`created_at`/`seq` per session) — the change-feed's data source. Small query;
   the ledger schema already supports it (ordered versions per artifact).

Building (1)–(3) in the ledger round means C1 later is **only** the dispatcher +
api-rs routes + daemon — no ledger reshape.

## Phasing & effort (rough)
- **C1.0 (this ledger round, near-free):** emit the pointer-advance NOTIFY +
  ensure serve-by-path + changed-since query exist. *(S)*
- **C1.1 (Centaur round, the real work):** Atrium dispatcher → api-rs receive +
  inbound-staging (path A) + change-feed route; the in-sandbox inbound daemon
  (image/entrypoint). *(M–L; the daemon + staging are the bulk.)*
- **C1.2 (optimization):** stdin `artifact.sync` poke + harness handling to cut
  poll latency. *(M, per-harness; gated on the Open item below.)*

## Open verification items
- **Harness extensibility for the stdin poke** — does codex/claude/amp act on a
  new `source` line, or treat all stdin as user turns? If not extensible, the poke
  needs a separate stdin reader; the egress-poll daemon sidesteps this entirely
  (why it's the primary).
- **Reuse `artifact_blobs` vs. a new inbound-staging table** — `artifact_blobs` is
  `(execution_id, ref)`, execution-lifetime; inbound artifacts belong to the
  *receiving* execution and may exceed its lifetime expectations → lean to a new
  table (path A).
- **Poll interval vs. latency** — 5–15 s egress poll is the freshness floor
  without the stdin poke; confirm that's acceptable for "live" collab or whether
  C1.2 is needed for v1.
