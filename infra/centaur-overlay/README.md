# Atrium Centaur prompt overlay

The Atrium org prompt addendum (the text that teaches agents about `~/context`,
the `[atrium context]` provenance blocks, artifact capture, and `/e/` citation
conventions) lives at **`centaur/services/sandbox/ATRIUM_OVERLAY_PROMPT.md`**
and is **baked into the sandbox image**: the Dockerfile copies it to
`/opt/centaur-overlay/services/sandbox/SYSTEM_PROMPT.md` and sets
`CENTAUR_OVERLAY_DIR=/opt/centaur-overlay`, which the entrypoint appends after
the base system prompt on every session start.

Why baked: the chart's `overlay.systemPrompt` ConfigMap is only mounted into
the api-rs pod; sandbox pods are created dynamically by api-rs and never see
it. Since we build `centaur-agent` ourselves, the image is the reliable
delivery vehicle. Deploying a prompt change = `cd centaur && just build-one
sandbox && just deploy`.

## Alternative: external overlay repo (kept for reference)

Deployments that prefer to keep the prompt out of the image can publish an
overlay tree as a repo synced by repo-cache and set a pod-level
`CENTAUR_OVERLAY_DIR` pointing at its clone — pod env overrides the image
default. Use `values.example.yaml` as the template (replace
`YOUR_ORG/atrium-centaur-overlay` and `main`); in flat-home deployments the
repo appears at `/home/agent/repos/YOUR_ORG/atrium-centaur-overlay`. Note the
repos mount is read-only to the agent, but keeping the prompt in agent-visible
repo space is a weaker posture than the baked path.
