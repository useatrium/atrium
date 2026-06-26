# Versioned App Presentations

## Goal

When an agent creates an app under `shared/apps/<slug>/`, Atrium should persist a
versioned presentation record. The UI can then render an inline, interactive app
preview in both the session transcript and channel timeline, and later connect
that preview history to published app versions.

## App Contract

Agents should create:

```text
shared/apps/<slug>/
  index.html
  atrium.app.json
```

`atrium.app.json` should be optional. When present, it can include:

```json
{
  "name": "support-triage-console",
  "title": "Support Triage Console",
  "description": "Prioritized support queue with SLA and routing views.",
  "entrypoint": "index.html",
  "renderer": "html-app",
  "preview": {
    "enabled": true,
    "url": "index.html?preview=1",
    "defaultSize": "card",
    "sizes": [
      { "id": "compact", "minWidth": 280, "height": 180 },
      { "id": "card", "minWidth": 420, "height": 260 },
      { "id": "wide", "minWidth": 640, "height": 360 }
    ]
  },
  "state": {
    "mode": "isolated"
  }
}
```

The preview is recommended, not required. If the preview is available, Atrium
uses it. Otherwise Atrium renders a plain app card with title, description, and
actions.

## Rendering Model

- Preview mode uses the app entry URL, usually `index.html?preview=1`.
- Atrium chooses the largest declared preview size that fits the current card.
- Atrium can append `previewSize=<id>` when loading the iframe.
- Previews are interactive but sandboxed.
- Preview state is isolated and ephemeral for now.
- Future shared state can be added with a manifest `state.mode`, but should not
  be enabled by default.

## Persistence Model

Add `app_presentations` as a versioned table. Each record represents a snapshot
of the app presentation as of a particular captured artifact state.

Important fields:

- workspace/channel/session identifiers
- app slug
- monotonically increasing version per session/app slug
- title, description, renderer
- entry path and preview URL
- preview sizing policy JSON
- manifest artifact id/seq/blob sha
- entry artifact id/seq/blob sha
- source event ids JSON

First pass behavior:

- Create a new version when the latest entry or manifest blob changes.
- `/api/sessions/:id/artifacts/presentations` returns latest versions.
- Existing computed presentation behavior remains as a fallback.
- Apps tab uses the same response shape, with extra version/id fields ignored by
  older UI code.

Future behavior:

- Session transcript and channel timeline cards should point to a specific
  `app_presentation_id`.
- Published app versions can link back to their source presentation.
- A history view can compare presentation versions and published versions.

## Open Questions

- Whether inline preview cards should be created as channel events immediately,
  or first exposed via the session stream and backfilled into the channel.
- Whether `preview.url` should allow paths other than the app entrypoint.
- Whether app preview sizing should support only fixed heights or also aspect
  ratios.
- Whether full app launch should remain on a separate apps origin. Current
  preference is yes: one shared apps-origin server for all apps, separate from
  the Atrium UI origin for isolation.
