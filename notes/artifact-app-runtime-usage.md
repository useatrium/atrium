# Artifact App Runtime Usage

Status: implemented (preview + apps surfaces + automatic presentation)
Updated: 2026-06-26

Agents surface browser-runnable work products ("apps" / applets / dashboards) to
humans with **zero ceremony**: build a static app in the right place and it shows up.

## The contract (agent side)

1. Build a self-contained static app at `shared/apps/<slug>/index.html` (browser-only:
   no backend, no API keys in the browser, no localStorage; embed sample data inline).
2. *Optionally* add `shared/apps/<slug>/atrium.app.json` for nicer presentation:
   ```json
   { "title": "Weather Dashboard", "description": "Live weather", "renderer": "html-app" }
   ```
   `entry` may point at a non-default file (e.g. `App.jsx` with `"renderer": "react-jsx"`).
   All fields optional — defaults are `title = <slug>`, `entry = index.html`, and the
   renderer is inferred from the entry extension (`.jsx`/`.tsx` → react-jsx, else html-app).

That's the whole gesture. There is **no `present` command and no event to emit** —
presentation is automatic.

## What happens

1. The node-sync overlay scan captures everything the agent writes under the workspace
   (no extension allow-list), so the app files land in Atrium's artifact ledger.
2. `GET /api/sessions/:id/artifacts/presentations` **auto-detects** every
   `shared/apps/<slug>/` that has an entry file and returns it as a presentation
   (manifest used only for metadata). The web client hydrates this and shows a
   "Presented app" tile in the Artifacts / What-changed surfaces.
3. Preview renders through `/api/sessions/:id/artifacts/preview` in a sandboxed iframe.
4. A human can **Publish** a detected app from the **Published apps** work tab to freeze
   a durable, launchable version (served from the apps origin via a signed URL).

`shared/apps/<slug>/` is a first-class workspace-scoped artifact root (recognized by the
path canonicalizer + scope ACL), so the agent can write there and any workspace member
reads it.

Agents learn this convention from the **`artifact-app-builder`** skill (Centaur).

## Known limitations

- The apps-origin CSP blocks the Tailwind CDN `<script>`, so a launched app that relies
  on it renders unstyled — bundle CSS, or use the preview route (which allows it).
- Presented apps surface in side surfaces (tiles + preview modal), not as an inline
  transcript card. The inline card is frame-driven; lighting it would need a
  Centaur-native `artifact.presented` frame (deferred).
- A first-class agent producer (an MCP `present_artifact` tool) remains deferred; the
  directory convention is the producer today.
