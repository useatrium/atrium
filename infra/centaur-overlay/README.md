# Atrium Centaur Overlay

This directory is the Atrium org prompt overlay for Centaur sandboxes. The prompt addendum lives at `services/sandbox/SYSTEM_PROMPT.md` and is appended after the base sandbox prompt when `CENTAUR_OVERLAY_DIR` points at this overlay tree.

## Deploy

The chart has an `overlay.systemPrompt` ConfigMap value, but in this checkout that ConfigMap is not mounted into sandbox pods. The working path is to publish this directory as a repo-cache overlay, then set `CENTAUR_OVERLAY_DIR` to that repo's sandbox path.

Use `values.example.yaml` as a template and include it through `CENTAUR_EXTRA_VALUES` with the existing local/dev values. Replace `YOUR_ORG/atrium-centaur-overlay` and `main` with the published overlay repo and ref.

In flat-home deployments, the overlay repo appears at:

```text
/home/agent/repos/YOUR_ORG/atrium-centaur-overlay
```

If this directory is baked into a sandbox image instead, set `sandbox.extraEnv.CENTAUR_OVERLAY_DIR` to the baked path that contains `services/sandbox/SYSTEM_PROMPT.md`.
