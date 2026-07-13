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
| `GET  sessions/:id/profile-bundles` | `profile-bundles.json` (element shape daemon-side; live check pins the envelope — seeding a real bundle needs the whole profile-writeback pipeline) |

Lanes covered by route-existence + daemon-side parsing only (their payloads
are opaque blobs or one-way writes): `artifacts/raw`, `atrium/channels`,
`atrium/sessions/:target/:doc`, `harness-transcript`, `harness-state-bundle`,
`profile-candidates`, `profile-baseline`, `profile-bundle-blob`,
`provider-credential-refresh`, `cache/blob`, `sessions/changes/batch`, and the
`changes/stream` SSE wake-up channel. The daemon treats every response as a
tolerant reader (unknown fields ignored, `serde(default)` everywhere) — keep
that doctrine; the fixtures are *minimums*, not exhaustive schemas.

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
