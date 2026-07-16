# The node-sync seam contract

The node-sync daemon is an Atrium-owned, AGPL crate that runs privileged on
every node. It cooperates with two permissively-licensed neighbors it must
never link against:

- **centaur** (the vendored fork under `centaur/`) — generates the sandbox pod
  specs that mount the daemon's overlays, exec into its DaemonSet pod, and run
  its binaries as init containers.
- **the Atrium server** (`surface/server`) — serves the `/api/internal/...`
  HTTP routes the daemon calls for capture, hydration, warm cache, context
  documents, and profile/transcript writeback.

Everything the three sides must agree on — the *seam* — is string constants
and JSON shapes. This document is the human narrative; the machine truth lives
next to it:

| What | Where | Checked by |
|---|---|---|
| Constants (mounts, env, markers, labels, container names, CLI flags) | [`contract/contract.toml`](contract/contract.toml) | `tests/contract.rs` (daemon) · `centaur-sandbox-agent-k8s` `overlay.rs` contract tests · `centaur-api-server` `args.rs` contract test |
| Wire shapes (minimum JSON each response must carry) | [`contract/fixtures/*.json`](contract/fixtures/) | `tests/contract.rs` + in-module parser tests (daemon) · `surface/server/test/internalContract.test.ts` (live routes) |
| Emitted argv (the exact init-container command lines + env) | `contract/fixtures/*-argv.json` | in-bin parser tests (daemon) · **emitted == fixture** equality tests (centaur) |

## How enforcement works

The contract directory is **data, consumed only by tests**. No shipped binary
reads it, so the license boundary is never crossed by linking — the permissive
side reads the files at test time (`CARGO_MANIFEST_DIR`-relative), which has no
effect on what its distributed binaries contain. Keep it that way: never
`include_str!` contract data into non-test centaur code.

The argv coverage is deliberately two-directional: centaur asserts its emitted
container args (and env) equal the fixture byte-for-byte, and the fixtures'
`parser_coverage` entries span the rest of each declared flag inventory (the
daemon suite asserts fixtures and declared lists span each other), so the
daemon's in-bin parse tests give `declared ⊆ accepted`. A renamed flag,
argument, or env var therefore cannot pass one side while starving the other.

Two seam participants live where no test lane can hook them: the heartbeat
WRITER is a `touch` in centaur's sandbox `entrypoint.sh` (shell), and the
context-ready READER is harness-server (a separate cargo workspace). The
daemon suite pins their literals by file-content assertion — deliberate
grep-tripwires, the exception rather than the pattern.

Drift on any side turns that side's own test lane red:

- **Daemon change** → `cargo fmt/clippy/test` in `runtime/node-sync` (the
  "Daemon fmt, clippy, and tests" step of the `node-sync overlay` CI job, on
  `runtime/node-sync/**` changes).
- **Pod-spec / config change in centaur** → `cargo test --workspace` in
  `centaur/services/api-rs` (the `Rust API` CI job; its path filter includes
  `runtime/node-sync/contract/**` so contract edits re-run it).
- **Internal-route change in surface/server** → `internalContract.test.ts` in
  the surface unit-test job, which runs on every `surface/**` change — this is
  deliberate: before this suite existed, a surface-only edit to
  `routes/internal-*.ts` ran **no** cross-check at all (the kind e2e only
  triggers on node-sync paths).
- **Contract-data change** → all three lanes run (both CI filters include
  `runtime/node-sync/contract/`).

The kind pod-native e2e (`ci/pod-native-e2e.sh`) remains the behavioral
backstop for the capture/hydrate hot path; this contract layer exists to catch
the cheap-and-common drift class (a renamed key, a moved mount, a changed env
name) in seconds on every PR.

## The pod-side contract (centaur ⟷ daemon)

All values live in `contract.toml`; headline entries:

- **Image + binaries** — one image (`centaur-node-sync`) serves as the
  DaemonSet, every init container, and the claimed-home helper pod. Binaries
  at `/usr/local/bin/{centaur-node-syncd,provision-overlay,warmcache-hydrate}`.
- **Host paths** — overlays root `/var/lib/centaur/overlays` (session uppers,
  `.sessions/<id>.json` manifests), merged root `/run/centaur/merged`
  (`Bidirectional` on the daemon, `HostToContainer` on agent pods), context
  root `/var/lib/centaur/atrium`, CAS `/var/lib/centaur/cas`, node depcache
  `/var/cache/centaur/depcache`, read-only repo cache `/cache`.
- **Markers** — `.centaur-workspace-ready` (provisioner → readiness-wait init),
  `.centaur-overlay-signature` (mount identity), `.atrium-context-ready`
  (context-mount seed complete), `~/.heartbeat` (agent liveness → eviction),
  `.sessions/` (manifest directory name).
- **k8s discovery** — DaemonSet pods labeled
  `app.kubernetes.io/component=node-sync`; the exec target container is named
  `node-sync`; init/helper container names are pinned so log/diagnostic
  tooling can find them.
- **CLI schemas** — the flag inventories for `provision-overlay`,
  `warmcache-hydrate`, and the daemon. Centaur may emit any subset (asserted);
  the parsers must keep accepting every declared flag (asserted via the argv
  fixtures, which record the exact command lines centaur builds today).
- **Sandbox-spec env keys** — the env vars / label on the *agent* pod spec
  that the provisioner metadata is derived from (`CENTAUR_THREAD_KEY`,
  `AGENT_REPOS_JSON`, harness homes, warm-pool markers, …).

## Environment variables

Canonical spelling: **`ATRIUM_BASE_URL`** + **`ATRIUM_CAPTURE_API_KEY`**.

History left three spellings across three components; since PR (this one),
every reader accepts both its own historical name and the canonical one:

| Component | Reads (in order) |
|---|---|
| daemon (`centaur-node-syncd`) | `ATRIUM_BASE_URL`, then `ATRIUM_URL` · `ATRIUM_CAPTURE_API_KEY`, then `ARTIFACT_CAPTURE_API_KEY` (a log line names the spelling when a fallback supplied the value) |
| `warmcache-hydrate` init | `--atrium-url`/`--atrium-key` flags, then `ATRIUM_URL`/`ARTIFACT_CAPTURE_API_KEY` (what centaur injects), then the canonical pair |
| Atrium server | `ARTIFACT_CAPTURE_API_KEY`, then `ATRIUM_CAPTURE_API_KEY` (pinned by `surface/server/test/configCaptureKey.test.ts`) |

The Helm chart's `secretKeyRef` mapping (`nodeSync.apiKeySecret`) is therefore
no longer the only thing standing between a misspelled key and a silent 401.
Chart defaults and the box secret are deliberately untouched.

## The wire contract (daemon ⟷ Atrium server)

All routes sit under `/api/internal/...`, auth is the `x-api-key` header
checked against the server's `ARTIFACT_CAPTURE_API_KEY`. The namespace is
**unversioned by design**: both sides ship from this repo in one PR, and the
contract directory is the compatibility gate. If the daemon ever ships
separately from the server, add versioning then — not before.

Fixture-pinned lanes (shape checked live on the server AND parsed by the
daemon's tests):

| Route | Fixture |
|---|---|
| `GET  sessions/:id/artifacts/changes` | `artifacts-changes.json` |
| `GET  sessions/:id/hydration-scope` | `hydration-scope.json` |
| `POST sessions/:id/artifacts/capture` (+ `capture-stream`, delete via `x-artifact-delete`) | `capture-response.json` |
| `GET  sessions/:id/cache/hydration` + `PUT sessions/:id/cache/manifest` | `warmcache-hydration.json` |
| `GET  sessions/:viewerId/atrium/changes` | `atrium-changes.json` |
| `GET  sessions/:viewerId/atrium/channels` | `atrium-channels.json` |
| `GET  sessions/:id/profile-bundles` | `profile-bundles.json` (element shape daemon-side; live check pins the envelope — seeding a real bundle needs the whole profile-writeback pipeline) |
| `GET  sessions/:id/git-identity` | `git-identity.json` (200 with the identity, or **204** when none is resolvable) |

The `git-identity` lane deserves a note, because its shape invites the wrong
home. It looks like a profile bundle and is deliberately not one: profile
bundles are user-authored files that get captured and **written back**, whereas
the git identity is server-derived per claim and must never round-trip (that is
the clobber class fixed in #97). It exists because commit authorship is the one
per-user value this architecture cannot inject at the HTTP boundary — the
iron-proxy rewrites headers, and authorship lives *inside* the payload, below
that seam. A warm pod's env is baked before the claiming principal is known, so
env cannot carry it either; per-session file materialization is the only channel
that reaches a claimed warm pod. On 204 the daemon writes nothing and the
image's baked `Centaur AI` identity stands — that fallback is the pre-existing
behavior, which is what makes this lane safe to ship dark.

**The identity file MUST land in the session's context root** (`~/context/.atrium-git-identity`,
the ext4 bind mount) and never in the agent's overlay home. This is load-bearing, not
stylistic, and it shipped wrong twice before anyone measured it. `entrypoint.sh` runs
`git config` at POD CREATION; git resolves the `[include]` target, gets ENOENT, and the
kernel caches a NEGATIVE dentry minutes before the claim that knows who the user is. So
the lookup has always already missed by the time the identity is written, and the only
question is whether that negative entry is invalidated. Overlay mount instances keep
independent dentry trees, so a node-side create — into `upper` OR through `merged`, both
were shipped — never invalidates the pod's entry: readdir lists the file while lookup
returns ENOENT, and the agent commits as `Centaur AI` with the file plainly on disk. A
bind mount of one ext4 superblock shares the dentry tree, so the create is observed even
after a failed lookup. `tests/git_identity_visibility.rs` pins exactly that ordering
(mount, MISS, write, hit); a test that writes before looking up passes on the broken
design too.

Lanes covered by route-existence + daemon-side parsing only (their payloads
are opaque blobs or one-way writes): `artifacts/raw`, `harness-transcript`,
`harness-state-bundle`, `profile-candidates`, `profile-baseline`,
`profile-bundle-blob`, `provider-credential-refresh`, `cache/blob`,
`sessions/changes/batch`, and the `changes/stream` SSE wake-up channel. The
daemon treats every response as a tolerant reader (unknown fields ignored,
`serde(default)` everywhere) — keep that doctrine; the fixtures are *minimums*,
not exhaustive schemas.

`atrium/sessions/:target/:doc` and `atrium/channels/:id/chat` carry opaque
(markdown/jsonl) bodies, so their contract lives in the *headers* — see below.

### The context-doc delta protocol

Constants: `contract.toml [atrium_delta]`. The context mount projects an
append-only log, so shipping whole documents made the daemon's work quadratic
in session length. The daemon now says what it already has
(`?since_seq=`/`?since_event_id=` + `?epoch=`) and the **server decides**
whether a delta is possible, answering `x-atrium-delta: append` (body = new
bytes only) or `full` (body = whole doc). The daemon never infers the mode; it
does what the header says.

Three rules carry the safety of this, and all three are load-bearing:

1. **The epoch is opaque.** The daemon compares it for equality and never
   parses it. The server composes it from the projection generation *and* a
   `render_version`, so a renderer edit invalidates already-written bytes
   instead of stranding old-format text at the head of an appended file.
   Bump `render_version` in the same commit as any renderer change.
2. **Append only against proven state.** Missing or corrupt daemon state, an
   epoch mismatch, or `mode = full` all mean truncate-and-rewrite. Appending
   onto a file whose provenance is unproven silently doubles it.
3. **Aggregates never delta.** `summary`/`meta` are recomputed from the whole
   session on every read (counts, first-N actions) and are ~1KB. The server
   always answers `full` for them. Do not contort them into deltas.

`last_event_id` on `atrium/channels` is now load-bearing (it was previously
decorative — the daemon rendered it into a table cell and compared it to
nothing). It is the watermark that lets the daemon skip an unchanged
`chat.md`, which is what stops the reconcile tick from re-downloading every
channel's chat for every viewer forever.

### Known quirks (documented, not bugs)

- The daemon's changes-feed parser reads an optional `group_id` per row, but
  the server's `ChangeRow` never emits it — group commits exist server-side
  (`commit-group` route) without per-row group tags in the feed. The field is
  always `None`; it is deliberately NOT in the fixture.
- The feeds use `next_cursor` (snake) beside `activePrefix`/`sessionId`
  (camel). Historical; pinned as-is — renaming either way is a contract change.

## Changing the contract

1. Edit the code on whichever side drives the change.
2. Update `contract.toml` / the fixture in the same PR.
3. The other sides' tests tell you exactly what else must move — make those
   changes in the same PR too (the repo ships both sides together; that's the
   whole point of the monorepo).
