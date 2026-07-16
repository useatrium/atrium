---
name: atrium-preview
description: "Create, check, and destroy a live Atrium branch preview when a user asks to see a branch running, see it live, or spin up a preview."
---

# Atrium Branch Previews

Create a preview only when the user explicitly asks for one. Never create one
proactively for a PR or branch: only three previews can run concurrently.

## What a Preview Is

A preview is a full, real Atrium with its own Postgres, MinIO, surface, and complete
Centaur runtime at `https://<preview-id>.atrium-preview.garybasin.com`. Sign in with any
handle; previews use open auth.

Real agents cannot run in a preview: it carries no model credentials, so summoning an
agent will not produce a real run. The built-in first-run demo ("Run a demo agent") does
work — it streams a scripted transcript — so the transcript UI can still be reviewed end
to end. Use previews to review UI, chat, and flows. Do not use them to judge real agent
behavior or model output, and tell the user this rather than letting them discover it.

Anyone with the link can access a preview. It contains no production secrets; never paste
secrets into it or assume it is private.

## Workflow

1. Commit the previewable changes and push the branch to `origin`. The CLI refuses an
   unpushed ref.
2. Create the preview. Only `useatrium/atrium` is supported:

   ```bash
   atrium-preview create --ref <branch> --repo useatrium/atrium
   ```

3. Allow about two minutes for creation. Keep progress in one work/status surface and
   update it as phases change; do not send a separate message for every phase. Check an
   existing preview with:

   ```bash
   atrium-preview status <id>
   ```

4. When ready, report the preview id, resolved commit SHA, URL, and expiry.
5. On failure, report the failed phase and message. Do not retry blindly.
6. If creation returns capacity status `429`, relay the running previews printed by the
   CLI and let the user choose what to destroy. Never evict another person's preview.
7. When the preview is no longer needed, offer:

   ```bash
   atrium-preview destroy <id>
   ```

   Previews expire automatically after 24 hours, so cleanup is a courtesy rather than an
   emergency.
