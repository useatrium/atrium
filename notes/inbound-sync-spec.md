# Inbound Sync (Track C1) — cross-system spec

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
