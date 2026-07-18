---
name: atrium-preview
description: "Create, update, check, and destroy a live Atrium branch preview when a user asks to see a branch running, see it live, or spin up a preview."
---

# Atrium Branch Previews

Create a preview only when the user explicitly asks for one. Never create one
proactively for a PR or branch: only three previews can run concurrently.

## What a Preview Is

A preview is a full, real Atrium with its own Postgres, MinIO, surface, and complete
Centaur runtime at `https://<preview-id>.atrium-preview.garybasin.com`.

**The preview is gated.** The URL the launcher returns carries a `?k=<token>` access
token — the first click mints a cookie and drops the token from the address bar. Always
hand the user the **full URL exactly as returned**, token included; the bare host answers
`401`. Inside, sign in with any handle (open auth); anyone with the link can get in, so it
holds no production secrets — never paste secrets into it.

**Real agents can run in a preview**, but only against a credential connected *inside that
preview*: it ships with no model key of its own. Tell the user to open the preview, connect
a provider (Codex or Claude) in settings, and then summon an agent — the credential lives
in that preview's own control plane and dies with it. Without a connected provider a
summon will not produce a real run. The built-in first-run demo ("Run a demo agent") always
works — it streams a scripted transcript — so the transcript UI can be reviewed regardless.

## Workflow

1. Commit the previewable changes and push the branch to `origin`. The CLI refuses an
   unpushed ref.
2. Create the preview. Only `useatrium/atrium` is supported:

   ```bash
   atrium-preview create --ref <branch> --repo useatrium/atrium
   ```

   **Re-running this for the same branch reuses that branch's preview**: a new commit is
   pushed into the existing stack in place (fast — no new environment, and the warm agent
   image and Postgres data are kept), rather than building a new one. The response's
   `action` is `created` or `updating`. Pass `--fresh` to force a brand-new stack instead.

3. Creation takes about two minutes (an update is usually faster — only the changed side
   rebuilds). Keep progress in one work/status surface and update it as phases change; do
   not send a separate message for every phase. Check an existing preview with:

   ```bash
   atrium-preview status <id>
   ```

4. When ready, report the preview id, resolved commit SHA, the **full `?k=` URL**, and
   expiry. If the user connected a provider, they can summon a real agent.
5. On failure, report the failed phase and message. Do not retry blindly. An update that
   fails leaves the preview standing on the previous code — it is not destroyed.
6. If creation returns capacity status `429`, relay the running previews printed by the
   CLI and let the user choose what to destroy. Never evict another person's preview.
7. When the preview is no longer needed, offer:

   ```bash
   atrium-preview destroy <id>
   ```

   Previews expire automatically after 24 hours, so cleanup is a courtesy rather than an
   emergency.
