# Harness-resume — live cluster e2e handoff (watched session)

Engineering DONE + merged. This is the remaining live-cluster validation (deferred
to a watched session per Gary). Everything below operates the kind `centaur`
cluster + spends real model calls — do it watched.

## What's landed
- **Atrium** (master): `harness_transcripts` store + `PUT/GET
  /api/internal/sessions/:id/harness-transcript?harness=<claude|codex>` (x-api-key).
- **Centaur** (canonical `fork/gb/harness-resume`; deploy via
  `fork/atrium/integration`): C1 daemon capture, C2 ephemeral home +
  entrypoint restore + conditional resume-trigger, and the **scoped restore proxy**
  `GET /agent/threads/{thread_key}/harness-transcript` (sandbox-token, thread-scoped,
  server-side Atrium key). All cargo tests green; api-rs workspace compiles.

## Deploy
1. Images: `just build-one api-rs` (done) + `just build-one sandbox` (done); build
   the node-sync binary/image if running it as a pod. From `~/Code/centaur-wt/harness-resume`.
2. `just deploy` — redeploys api-rs (the route + runtime resume logic) + sandbox
   (entrypoint restore). NB this disrupts running `asbx-*` pods.
3. **Server-side config the proxy needs** (NOT in the sandbox): api-rs must have the
   Atrium base URL + `ATRIUM_CAPTURE_API_KEY` (the proxy reads them via
   `configured_atrium_proxy()`), and api-rs→Atrium egress must be allowed. Verify in
   `contrib/chart/values.yaml` (`nodeSync.atriumEgress` etc.) + the api-rs env.
4. **Atrium** must be running + reachable from the cluster (the api-rs proxy + the
   capture daemon both call it). Atrium = the surface server + PG(:5433) + MinIO(:9000).
5. **Capture daemon**: node-sync isn't a DaemonSet locally — run it like the prior
   `surface/server/scripts/distributed-daemon-e2e.sh`, with `NODE_SYNC_HARNESS` and
   the per-session harness-thread-id env (report open-risk #1).

## Drive the e2e (Claude + Codex)
1. Spawn a **Claude** session; run one turn: "Remember the number 4271. Reply ok."
2. Confirm capture: daemon logs "harness transcript: captured …"; Atrium `GET
   .../harness-transcript?harness=claude` returns bytes.
3. Tear down the sandbox (delete the pod, or wait for Atrium's 60s release).
4. Steer again: "What number did I tell you?" → fresh container → entrypoint logs
   "harness transcript restored …" → `claude --resume` → **the agent recalls 4271**.
5. Repeat for **Codex** (verify `CODEX_CONTINUE_THREAD_ID` is present ONLY on the
   resumed sandbox, absent on fresh starts).
6. **dev-browser**: the session pane's resumed turn answers with prior memory.
7. **Security check**: exec into the sandbox, confirm `ATRIUM_CAPTURE_API_KEY` is
   NOT set (only the scoped `CENTAUR_API_KEY` sandbox-token) — the restore must work
   without the broad key.

## Pass criteria
Claude + Codex both resume a torn-down session with full prior context, the
transcript round-trips through Atrium's store, and the sandbox never holds the broad
key. Then it's done.
