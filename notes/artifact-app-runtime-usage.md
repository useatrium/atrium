# Artifact App Runtime Usage

Status: pathfinder implementation note
Date: 2026-06-25

End-to-end path for static applet-style artifacts (preview + apps surfaces landed;
producer is manifest-based):

1. The agent creates a static app under `shared/apps/<slug>/` (e.g. `index.html`).
2. The agent marks it presented by writing `shared/apps/<slug>/atrium.app.json` (the
   `atrium-present` helper does this — no Atrium credential / back-channel needed).
3. Centaur captures both files into the artifact ledger.
4. Atrium derives presentations from committed manifests via
   `GET /api/sessions/:id/artifacts/presentations` (NOT a synthetic stream frame — the
   Centaur `event_id` space is gap-checked and can't take injected frames). The web
   client hydrates that endpoint and shows the app as a "Presented app" tile with a
   Preview that renders through `/api/sessions/:id/artifacts/preview`.
5. A user can publish a detected `shared/apps/<slug>/` directory from the **Published
   apps** work surface and launch the frozen version (served from the apps origin).

`shared/apps/<slug>/` is a first-class workspace-scoped artifact root (recognized by
the path canonicalizer + scope ACL), so the agent can write there and humans read it
workspace-wide.

Known limitations: the apps-origin CSP blocks the Tailwind CDN `<script>`, so launched
apps that rely on it render unstyled (bundle CSS, or use the preview route which allows
it). A first-class agent producer (an MCP `present_artifact` tool) is still deferred —
today the manifest file IS the producer.

## Agent Happy Path

Create a small static app:

```bash
mkdir -p shared/apps/demo
cat > shared/apps/demo/index.html <<'HTML'
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo Artifact</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; }
      button { font: inherit; padding: 0.5rem 0.75rem; }
    </style>
  </head>
  <body>
    <h1>Demo Artifact</h1>
    <p id="count">0</p>
    <button id="inc">Increment</button>
    <script>
      let count = 0;
      document.getElementById('inc').onclick = () => {
        count += 1;
        document.getElementById('count').textContent = String(count);
      };
    </script>
  </body>
</html>
HTML
```

Present it:

```bash
atrium-present shared/apps/demo/index.html --renderer html-app --title "Demo Artifact"
```

Then open the Atrium Artifacts/What changed surface and click **Preview app** on
the HTML artifact. To make it durable in the workspace app registry, open
**Published apps** in the Work drawer and click **Publish** for the detected app
directory.

Centaur's pathfinder capture roots include both the older workspace path and the
flat-home app paths:

```text
/home/agent/workspace
/home/agent/shared
/home/agent/apps
```

So `shared/apps/<slug>/index.html` works when the sandbox cwd is either
`/home/agent/workspace` or `/home/agent`.

## React-ish Source Preview

The preview route also supports a rough `.jsx`/`.tsx` pathfinder mode:

```bash
atrium-present shared/apps/demo/App.jsx --renderer react-jsx --title "React Demo"
```

This mode is intentionally limited. It wraps the source in a browser-side React
preview and is useful for experiments, but the recommended path for real React
apps is still:

```text
React/Vite project -> static build output -> present index.html
```

## Current Limitations

- Preview is pathfinder-grade and prioritizes visible user value over the final
  isolated-origin security model.
- Existing artifact download routes still serve non-images as attachments.
- The preview route is separate: `/api/sessions/:id/artifacts/preview`.
- Bundled apps must be small enough for Centaur capture, or the preview will not
  have bytes to render.
- Published apps are version-frozen in Atrium's database, but launch currently
  uses the authenticated preview route rather than the final separate apps
  origin and S3-only HMAC grant model from `notes/artifact-apps-plan.md`.
