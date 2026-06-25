# Claude-Like Artifacts In Atrium And Centaur

Status: exploratory design note
Date: 2026-06-24

## Executive summary

Atrium and Centaur already have the hardest lower-level primitive for artifact support: files created by an agent can be captured from the sandbox, streamed through Centaur, mirrored into Atrium, and committed into a workspace-scoped content-addressed artifact ledger.

What they do not yet have is the Claude Artifacts product model:

- an explicit authoring contract that tells the agent "create this displayable artifact and present it";
- a runtime renderer that selects a safe viewer based on artifact type;
- a browser sandbox that can run untrusted generated applications without exposing Atrium's authenticated origin;
- a polished UI concept for "this artifact is the answer" rather than "this is one captured file among many";
- optional bridges for storage, model calls, MCP/data connectors, and workspace data.

The current Atrium/Centaur architecture is closer to "artifact capture and durable file ledger" than to "artifact runtime". That is a good foundation. The right first implementation is probably not a full Claude-compatible `.jsx` runtime. It is a static artifact app pipeline: agents produce self-contained HTML or a small static app directory, Atrium freezes a version from the artifact ledger, and the web UI launches it from an isolated origin inside a sandboxed iframe.

There is already a local design doc that points in this direction: `notes/artifact-apps-plan.md`. Its v1 choices are conservative and appropriate:

- static client-side apps only;
- separate app serving origin;
- signed launch URLs;
- sandboxed iframe;
- restrictive CSP;
- no dynamic server-backed apps;
- no agent-callable app tools;
- no scoped data SDK in v1.

The main recommendation of this note is to build on that plan, add an explicit "present/publish artifact" flow, and defer a Claude-style `.jsx` renderer until after the static app pipeline exists.

## The user's Claude Artifacts model, reduced to product primitives

The prompt supplied by the user describes Claude Artifacts as two different systems that work together:

1. A build-time authoring environment.
2. A runtime rendering environment.

That distinction matters because Atrium/Centaur already cover some build-time persistence but almost none of the runtime rendering.

### Build-time authoring

In the described Claude model, the agent receives instructions and tools that are artifact-aware:

- write an output file into a known output directory;
- choose a supported type such as `.html`, `.jsx`, `.svg`, `.md`, `.mermaid`, or `.pdf`;
- read relevant skills before doing artifact work;
- keep the artifact self-contained unless a larger build is justified;
- call a presentation tool when finished.

The key product primitive is not just "a file exists". It is "the assistant intentionally presented this file to the user as an artifact".

That distinction is missing from Atrium today. Centaur captures files opportunistically. Atrium displays captured files. But no current contract says that one file is the primary rendered output, should be opened in a preview pane, or should be treated as an interactive application.

### Runtime rendering

In the described Claude model, the web app recognizes artifact type and dispatches to a renderer:

- `.jsx` gets a React runtime and import resolver;
- `.html` runs as a self-contained webpage;
- `.svg` displays as SVG;
- `.mermaid` renders as a diagram;
- `.md` renders as Markdown;
- `.pdf` renders as a document.

The runtime is separate from the model's build environment. The generated app runs in a browser sandbox with restricted privileges.

Atrium does not currently have this artifact renderer layer. It has an artifact gallery and download/open links. The server intentionally prevents non-image artifacts from being rendered inline from the authenticated application origin.

That security decision is correct and should not be weakened.

## Current Atrium/Centaur state

This section summarizes what exists in the local repos as of this investigation.

### Centaur captures files from agent sandboxes

Centaur has an artifact capture producer side documented in:

- `../centaur/ARTIFACT_CAPTURE_SPEC.md`
- `../centaur/ARTIFACT_CAPTURE_REPORT.md`
- `../centaur/services/sandbox/artifact_capture.py`
- `../centaur/services/api-rs/crates/centaur-api-server/src/routes.rs`

The current capture flow is:

```text
agent writes file in sandbox
    |
capture worker/poller notices it
    |
POST /agent/executions/{execution_id}/artifacts
    |
Centaur stages bytes and emits artifact.captured event
    |
Atrium mirrors event and later offloads bytes
```

The `artifact.captured` payload includes:

```json
{
  "artifact_id": "...",
  "path": "...",
  "kind": "created",
  "mime": "...",
  "size_bytes": 123,
  "sha256": "...",
  "ref": "..."
}
```

The current Python capture worker allows common static artifact formats, including:

- `.html`
- `.svg`
- `.md`
- `.csv`
- `.pdf`
- common image/audio/video extensions

It does not currently list `.jsx` as a captured extension.

The default capture size cap is small:

```text
DEFAULT_MAX_BYTES = 1_048_576
```

Larger files can become manifest-only captures with no staged bytes. That matters for bundled HTML apps, because a Vite/React single-file bundle can exceed 1 MiB quickly if dependencies are inlined.

Centaur's artifact byte route is intentionally defensive. `get_artifact` sets:

- `X-Content-Type-Options: nosniff`
- `Content-Disposition: attachment`

The route comment explicitly calls out planted `text/html` as a risk. That posture should remain in place for generic artifact downloads.

### Centaur is a harness and sandbox orchestration system, not the artifact runtime

Centaur can run multiple agent harnesses. The Rust session core includes:

```rust
pub enum HarnessType {
    Codex,
    Amp,
    ClaudeCode,
}
```

Centaur also has skills, sandbox prompts, and runtime context files. Its role is to stand up the agent execution environment and stream events back. It is not currently a browser renderer for artifacts.

For Claude-like artifacts, Centaur is the build-time side:

- it provides the sandbox where files are created;
- it can provide system prompt or skill instructions;
- it can expose a CLI/tool that marks artifacts for presentation;
- it can emit events for captured and presented artifacts.

Atrium should own the user-facing runtime:

- gallery;
- preview pane;
- app publish flow;
- iframe launch;
- permissions and signed URLs;
- data/storage/model bridges if added later.

### Atrium stores artifacts in a workspace-scoped ledger

Atrium mirrors Centaur events and records artifact data in:

- `surface/server/src/session-runs.ts`
- `surface/server/src/artifact-ledger.ts`
- `surface/server/migrations/031_session_artifacts.sql`
- `surface/server/migrations/033_artifact_ledger.sql`
- `surface/server/migrations/036_artifact_blob_refs.sql`
- `surface/server/migrations/042_workspace_scoped_artifacts.sql`

The important architectural point is that Atrium now has workspace-scoped artifact identity:

```text
(workspace_id, path)
```

This means artifacts can outlive a single session and can represent shared workspace files. That is a better foundation than treating every artifact as a one-off session attachment.

`session-runs.ts` does two things when it receives `artifact.captured`:

1. records the session artifact mirror;
2. ingests the file into the artifact ledger.

The ledger commits versions using the captured path, blob SHA, author, and merge class.

The merge class currently distinguishes:

- text/markdown/json as mergeable documents;
- most binary/application artifacts as immutable.

For artifact apps, immutable versioning is acceptable and probably desirable.

### Atrium currently presents artifacts as gallery/download items

The current web UI is mostly in:

- `surface/web/src/sessions/ArtifactsSurface.tsx`
- `surface/web/src/sessions/FilesSurface.tsx`
- `surface/centaur-client/src/artifacts.ts`
- `surface/centaur-client/src/reducer.ts`

The artifact gallery can show image thumbnails. Non-image artifacts are displayed as generic file tiles. If servable, the tile links to:

```text
/api/sessions/:id/artifacts/by-path?path=...
```

The server route intentionally renders images inline but serves non-images as attachments. In `surface/server/src/app.ts`, the artifact proxy path sets:

- `X-Content-Type-Options: nosniff`
- `Content-Disposition: inline` only for images;
- `Content-Disposition: attachment` for everything else.

This is why Atrium is currently a safe artifact file browser, not an artifact app runtime.

### Atrium already has a static app plan

`notes/artifact-apps-plan.md` is highly relevant. It describes a v1 "Artifact Apps" plan:

- publish and launch static client-side apps;
- store app versions from existing artifact ledger blobs;
- serve from an isolated app origin;
- use signed URL path grants;
- embed in sandboxed iframes;
- restrict CSP;
- keep v1 static only.

That plan is the closest existing Atrium equivalent to Claude Artifacts runtime design.

It is also more production-shaped than simply allowing HTML artifacts to render from the existing API route.

### Flat-home and capture are in transition

Several local notes describe a transition from older workspace capture behavior to a flat-home workspace model:

- `notes/shared-workspace-build-spec.md`
- `notes/flat-home-workspace-design.md`
- `notes/in-agent-poll-cutover-plan.md`

The target agent filesystem looks like:

```text
/home/agent
  report.md
  data.csv
  shared/
  repos/
  context/
```

The target capture rule is:

```text
capture non-dotfile entries under ~, excluding repos/ and context/
```

But the cutover note says the old in-pod poll path is still active by default in production-like setups. Any artifact-app design should work with current capture and not depend entirely on the new daemon path until that cutover is complete.

## Gap analysis versus Claude Artifacts

### Already present

Atrium/Centaur already have:

- sandbox execution;
- agent file creation;
- file capture;
- artifact events;
- artifact persistence;
- workspace-scoped artifact identity;
- CAS blob storage;
- basic gallery UI;
- file serving with safe defaults;
- skills infrastructure in Centaur;
- a written static artifact-app plan in Atrium notes.

These are meaningful foundations. The system is not starting from zero.

### Missing or incomplete

Atrium/Centaur do not yet have:

- an explicit `present_files` equivalent;
- a first-class "render this artifact" event;
- renderer dispatch by file extension;
- safe inline HTML rendering;
- React `.jsx` rendering;
- Tailwind runtime for generated components;
- a library import map for React artifacts;
- a static app publish schema implemented in code;
- a separate artifact app origin implemented in the server/client;
- a user-visible preview pane for interactive artifacts;
- persistent artifact storage bridge like `window.storage`;
- model/API bridge from inside artifacts;
- MCP/data connector bridge from inside artifacts;
- clear agent instructions for how to create Atrium-renderable artifacts.

The largest missing piece is not storage. It is runtime isolation and product semantics.

## Design principle: separate captured files from executable artifacts

Generated HTML, SVG, and JavaScript are untrusted code. They may be created by an agent, by a compromised dependency, by a prompt injection, or by a malicious file in a repo the agent touched.

Atrium's generic artifact routes should continue to treat those bytes as files, not executable web apps.

The product should distinguish:

```text
captured artifact
    A file that exists in the workspace ledger.

presented artifact
    A file the agent intentionally surfaced as an answer.

published artifact app
    A frozen, permission-checked, separately served app version.
```

Those states can overlap, but they should not be collapsed.

This distinction allows safe defaults:

- every generated file can be captured;
- only selected files become preview candidates;
- only validated/published files get executable runtime treatment.

## Possible architecture

The most defensible architecture for Atrium is:

```text
Centaur sandbox
  agent writes files
  agent calls "atrium present" or writes manifest
        |
        v
Centaur event stream
  artifact.captured
  artifact.presented
        |
        v
Atrium server
  mirrors events
  commits blobs to artifact ledger
  freezes selected app versions
  issues signed launch URLs
        |
        v
Atrium web
  gallery
  preview affordance
  app iframe shell
        |
        v
isolated app origin
  serves frozen static files
  enforces CSP
  runs in sandboxed iframe
```

This keeps responsibilities clear:

- Centaur builds and captures.
- Atrium stores and authorizes.
- The isolated app origin executes untrusted frontend code.

## Design option 1: single-file HTML preview

This is the smallest useful artifact runtime.

### How it would work

1. Agent writes a self-contained HTML file.
2. Centaur captures it as `text/html`.
3. Atrium ingests it into the artifact ledger.
4. The user clicks "Preview" or the agent emits `artifact.presented`.
5. Atrium creates a signed preview URL for that exact blob/version.
6. Atrium web opens an iframe to a separate app origin.
7. The app origin serves the HTML with strict sandbox/CSP.

The generic artifact download route remains unchanged.

### Runtime constraints

For v1, the preview should likely require:

- one HTML document;
- no network access;
- no cookies;
- no local/session storage;
- no same-origin access to Atrium;
- no forms;
- no top navigation;
- no popups;
- no external scripts unless explicitly allowed later.

The iframe sandbox could start as:

```html
<iframe sandbox="allow-scripts" ...>
```

Critically, it should not include `allow-same-origin` for untrusted generated apps. Without `allow-same-origin`, the iframe gets an opaque origin and cannot use ordinary origin-bound storage or cookies.

The CSP could start roughly as:

```text
default-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'none';
form-action 'none';
base-uri 'none';
frame-ancestors <atrium web origin>;
```

If the HTML is served directly from a blob route, inline scripts may be necessary. If Atrium rewrites or packages the app into separate files, `unsafe-inline` can potentially be reduced.

### Pros

- Delivers a visible Claude-like capability quickly.
- Uses existing Centaur capture and Atrium ledger.
- Avoids building a React import resolver.
- Forces the right security boundary early.
- Works well for charts, dashboards, forms, calculators, games, and demos.

### Cons

- No first-class React source format.
- No multi-file apps unless assets are embedded as data URLs or captured separately.
- Large bundled apps may exceed current Centaur capture caps.
- Debugging generated HTML failures is less pleasant than a project build.
- No data/API bridge.

### Recommendation

This is the right first runtime if the goal is to make artifacts feel real in Atrium soon.

It should be implemented as an isolated preview/app route, not by changing the existing artifact download route to render HTML inline.

## Design option 2: published static artifact apps

This is the path described in `notes/artifact-apps-plan.md`.

### How it would work

An app is a set of frozen artifact ledger versions, likely rooted at a manifest:

```text
shared/apps/sales-dashboard/atrium.app.json
shared/apps/sales-dashboard/index.html
shared/apps/sales-dashboard/assets/chart.js
shared/apps/sales-dashboard/assets/styles.css
```

The manifest could include:

```json
{
  "name": "Sales Dashboard",
  "entry": "index.html",
  "type": "static",
  "permissions": {
    "connect": []
  }
}
```

Publishing would freeze exact ledger versions:

```text
artifact_id
version_seq
blob_sha
mime
size
path
```

Launching would issue a signed URL for a specific app version.

### Pros

- Durable and shareable.
- Versioned.
- Can support multi-file static apps.
- Cleanly separates authoring from runtime.
- Aligns with existing workspace-scoped artifact ledger.
- Can eventually support review/approval before execution.
- Creates a natural place to attach permissions and capabilities.

### Cons

- Requires DB schema and server routes if not already implemented.
- Requires a publish UI or agent-visible publish command.
- Requires an app-origin deployment story.
- Requires careful asset path handling.
- More product surface than a single-file preview.

### Recommendation

This is the best v1/v1.5 product architecture. If time permits, skip a throwaway single-file-only design and implement the static app plan directly, while allowing the app to contain only one `index.html` at first.

## Design option 3: Claude-like `.jsx` React artifacts

Claude's most recognizable artifact type is a single default-exported React component. Atrium could emulate that.

### How it might work

The agent writes:

```jsx
import React, { useState } from "react";
import { Search } from "lucide-react";

export default function App() {
  const [query, setQuery] = useState("");
  return <input value={query} onChange={(event) => setQuery(event.target.value)} />;
}
```

Atrium then renders it with:

- React;
- ReactDOM;
- a JSX transform;
- Tailwind stylesheet;
- a limited import map;
- a wrapper that mounts the default export.

There are two ways to implement this.

### 3A: runtime interpretation in the iframe

The app iframe receives the `.jsx` source, transpiles it in the browser, resolves imports from a supported package map, and mounts the component.

This is similar to how early Claude Artifacts were reported to work.

Pros:

- Fast iteration.
- Small source artifacts.
- Friendly to agents.
- No server build step.

Cons:

- Requires browser-side transpilation/eval.
- Requires a package resolver.
- Requires version pinning and global dependency loading.
- Harder to lock down CSP.
- More fragile across browsers.
- More implementation surface in the most security-sensitive layer.

### 3B: compile at publish time

Atrium treats `.jsx` as source, but compiles it into a static HTML/JS bundle before publishing.

Possible implementation:

```text
artifact.jsx
    |
server-side or worker-side esbuild/Vite compile
    |
frozen static app bundle
    |
isolated app origin iframe
```

Pros:

- Runtime remains static app serving.
- Build errors are explicit.
- Dependencies can be pinned.
- CSP can be stronger.
- Easier to cache and version.
- Better long-term operational model.

Cons:

- Requires a build service or server-side bundling worker.
- Requires dependency allowlist.
- Requires UI for build failures.
- Makes simple previews slower.
- Needs repair loop if agent output does not compile.

### Recommendation

If Atrium wants React artifacts, compile them into static app versions rather than building a browser eval runtime first.

The static HTML app pipeline is a prerequisite either way. Once that exists, `.jsx` can be added as an authoring convenience:

```text
.jsx source artifact -> compiler -> static app version -> iframe runtime
```

That keeps "React artifact" as a build-time format, not a privileged runtime mode.

## Design option 4: complex project builder skill

Claude's more complex artifact path appears to scaffold a conventional React/Vite/TypeScript project and bundle it down to one static HTML file.

Atrium/Centaur can support the same pattern without any special `.jsx` runtime.

### How it would work

Add a Centaur skill, for example:

```text
artifact-app-builder/SKILL.md
```

The skill would instruct agents to:

1. create a small Vite/React project in a scratch/build directory;
2. implement the app normally;
3. run checks/build;
4. bundle into a static `index.html` plus assets, or a single self-contained HTML file;
5. place the final app under the capture path;
6. call the Atrium present/publish tool.

For simple artifacts, the skill should say not to scaffold a full project. A single HTML file should remain preferred for small tools.

### Pros

- Uses normal frontend tooling.
- Lets agents build larger multi-component apps.
- Avoids a custom JSX runtime.
- Matches a pattern Anthropic has publicly described through skills.
- Can produce the same static app format as option 2.

### Cons

- Requires Node/package availability in the Centaur sandbox.
- Dependency installs may need network policy decisions.
- Bundles can exceed current artifact capture caps.
- Build output directories may currently be ignored by capture rules.
- More expensive and slower than single-file artifacts.

### Recommendation

This is probably the best "power user" path after static app publishing exists.

The near-term version can be conservative:

- use templates vendored into a skill;
- keep dependency set small;
- bundle with known installed tools;
- output under a captured `shared/apps/<slug>/` path;
- keep network optional or disabled.

## Design option 5: live sandbox app preview

Instead of capturing static files, Atrium could preview a live dev server running inside the Centaur sandbox.

### How it would work

1. Agent starts a dev server in the sandbox.
2. Centaur exposes or proxies a port.
3. Atrium embeds the live server in an iframe.

### Pros

- Excellent developer ergonomics.
- Supports hot reload.
- Supports arbitrary server-backed demos.
- Avoids bundling before preview.

### Cons

- Much harder security model.
- Requires inbound routing to sandbox pods.
- Requires lifecycle management.
- Requires auth and origin isolation.
- Sandboxes are ephemeral.
- Apps become unavailable when the session ends.
- Exposes much larger attack surface than static serving.

### Recommendation

Do not make this v1.

It may be useful later for developer workflows, but it is a different product from durable Claude-like artifacts.

## Design option 6: data/API-connected artifact apps

The user specifically asked how Claude-like artifacts might connect to business data. In Atrium, this should be explicit and permissioned.

### Possible future bridge

A generated app could receive a restricted SDK injected by the iframe shell:

```js
const rows = await window.atrium.query("salesforce.opportunities", {
  fields: ["name", "amount", "stage"],
  limit: 100
});
```

Or:

```js
const result = await window.atrium.callTool("google_sheets.read_range", {
  sheetId,
  range: "A1:F100"
});
```

Under the hood:

```text
artifact iframe
  postMessage request
Atrium web shell
  validates app version and user intent
Atrium server
  enforces capability grant
connector/MCP service
  returns scoped result
```

The app should not receive raw API keys. The viewer/user should authorize access, and the server should enforce:

- app version identity;
- workspace identity;
- user identity;
- connector capability;
- allowed scopes;
- rate limits;
- audit logging.

### Why this should not be v1

Data-connected apps multiply the security problem.

With static apps, the main risk is browser sandbox escape or social engineering. With data-connected apps, the generated code can exfiltrate sensitive business data if `connect-src` or bridges are too broad.

The right sequence is:

1. static artifact runtime;
2. app versioning and permissions;
3. explicit storage bridge;
4. read-only scoped data bridge;
5. write-capable connector bridge;
6. agent-callable/app-callable tools, if needed.

## Proposed v1 product behavior

The most useful v1 would feel like this:

1. User asks an agent to build a visualization, tool, or mini-app.
2. Agent creates `shared/apps/<slug>/index.html`.
3. Agent runs a local smoke test if possible.
4. Agent calls:

   ```bash
   atrium present shared/apps/<slug>/index.html --kind app --title "Pipeline Dashboard"
   ```

5. Centaur emits:

   ```json
   {
     "event": "artifact.presented",
     "data": {
       "path": "shared/apps/pipeline-dashboard/index.html",
       "title": "Pipeline Dashboard",
       "renderer": "html-app"
     }
   }
   ```

6. Atrium highlights the artifact in the transcript.
7. User clicks "Open".
8. Atrium launches it in an isolated iframe.

This is the closest analogue to Claude's `present_files()` without requiring Atrium to copy Claude's internals.

## Proposed implementation plan

### Phase 0: align terminology and preserve safe defaults

Document the three artifact states:

- captured;
- presented;
- published.

Do not change generic artifact routes to inline-render HTML.

Keep current attachment behavior in:

- `surface/server/src/app.ts`
- Centaur's `get_artifact` route

### Phase 1: explicit presentation event

Add a small Centaur/Atrium contract for intentional presentation.

Possible event:

```json
{
  "event": "artifact.presented",
  "data": {
    "path": "shared/apps/example/index.html",
    "artifact_id": "optional",
    "title": "Example",
    "renderer": "html-app",
    "description": "optional"
  }
}
```

Implementation choices:

- a sandbox CLI command;
- a tool shim;
- a manifest file that capture code recognizes;
- a server API endpoint called from the sandbox.

The CLI/tool approach is clearer than manifest sniffing because it mirrors Claude's explicit `present_files()`.

### Phase 2: isolated single-file HTML preview

Add a preview flow for exact artifact ledger versions.

Server responsibilities:

- resolve workspace/path to immutable artifact version;
- create short-lived signed launch token;
- serve artifact from isolated app origin;
- attach strict CSP;
- prevent access to generic Atrium cookies/API.

Client responsibilities:

- add "Preview" action for renderable HTML artifacts;
- open iframe shell;
- show clear version/path metadata;
- handle preview failures.

Important: this should not be implemented with `srcDoc` containing arbitrary artifact HTML inside the main Atrium origin unless the iframe is locked down and no privileged data is reachable. A separate origin is cleaner.

### Phase 3: published static app versions

Implement or complete the model described in `notes/artifact-apps-plan.md`.

Likely schema:

- `artifact_apps`
- `artifact_app_versions`
- `artifact_app_version_files`

Version rows should freeze:

- artifact id;
- version sequence;
- blob SHA;
- path;
- mime;
- size.

The app version, not just the path, should be the unit of launch authorization.

### Phase 4: app builder skill

Add a Centaur skill that tells agents how to create Atrium artifact apps.

The skill should include:

- when to use single-file HTML;
- when to scaffold a Vite project;
- where to place output files;
- how to keep apps self-contained;
- how to avoid local/session storage in v1;
- how to avoid external network calls in v1;
- how to call the present/publish command;
- size limits and bundling guidance.

This gives the model an authoring contract analogous to Claude's artifact instructions.

### Phase 5: optional JSX source support

After static apps are working, add `.jsx` as source format.

Recommended path:

```text
source artifact .jsx
    |
compile with pinned dependency allowlist
    |
static app version
    |
isolated iframe
```

Avoid browser-side arbitrary import resolution for v1.

### Phase 6: storage and data bridges

Add bridges only after app identity and versioning exist.

Possible bridges:

- `window.atrium.storage`
- `window.atrium.query`
- `window.atrium.callTool`
- `window.atrium.model`

All should communicate through `postMessage` to a parent shell and then to the Atrium server. The iframe should not get raw credentials.

## Security model

The generated app must be treated as hostile.

### Threats

Generated artifacts may attempt to:

- read Atrium auth cookies;
- call Atrium APIs as the user;
- exfiltrate workspace data;
- phish the user;
- open popups;
- navigate the top-level page;
- abuse storage as a tracking channel;
- import remote scripts;
- use SVG/HTML parser quirks;
- exploit browser bugs;
- trick the user into approving connector access.

### Required boundaries

The artifact runtime should have:

- separate origin from Atrium web;
- iframe sandbox;
- no `allow-same-origin` for untrusted apps, unless a later design has a compelling reason;
- no Atrium cookies on app origin;
- signed launch URLs scoped to app version;
- short token TTLs;
- CSP with `connect-src 'none'` in v1;
- no uncontrolled external script URLs;
- no generic inline rendering from API routes;
- audit trail for presentation/publish actions.

### HTML and SVG

SVG is dangerous if treated as image-only. Inline SVG can contain script and foreignObject behavior depending on context. For v1, render SVG either:

- as an inert image with proper headers and no script execution; or
- through the same app sandbox if it is considered executable content.

Do not simply inline arbitrary generated SVG into Atrium's React DOM.

### PDF

PDF preview is less like app runtime and more like document preview. It may be reasonable to inline PDFs, as parts of Atrium already do for uploaded files, but generated PDFs still deserve careful headers and viewer isolation.

## File format strategy

### HTML

Best v1 executable artifact format.

Constraints:

- self-contained or static app manifest;
- no network;
- no privileged storage;
- no Atrium API calls;
- served only from app origin.

### JSX

Good authoring format, not necessary as a runtime format.

Recommendation:

- allow capture of `.jsx` eventually;
- compile into static app;
- expose compile errors clearly.

### Markdown

Markdown can be rendered safely with sanitization. This is a separate renderer from executable artifact apps.

Useful for:

- reports;
- documentation;
- generated specs;
- notebook-like results.

Risk:

- embedded HTML;
- links/images;
- scriptable extensions.

### Mermaid

Mermaid rendering can be useful but should happen through a locked-down renderer. It is not needed for the first app runtime.

### SVG

Treat as risky. Prefer rendering as inert image or sandboxed document.

### PDF

Good for document artifacts, separate from app artifacts.

## Agent authoring contract

An Atrium artifact skill could say something like:

```text
When asked to create an interactive artifact for Atrium:

1. Prefer a single self-contained HTML file for small tools.
2. Put app artifacts under shared/apps/<slug>/.
3. Use index.html as the entrypoint.
4. Do not depend on localStorage or sessionStorage.
5. Do not make external network calls.
6. Keep generated files small enough to be captured.
7. Run a smoke test when possible.
8. Present the artifact with atrium present.
```

For complex apps:

```text
Use the artifact app builder template.
Build to a static output.
Publish only the static output, not node_modules or source caches.
```

This mirrors Claude's skills-driven behavior without requiring Atrium to exactly replicate Claude's runtime.

## UI model in Atrium

### Current UI

Atrium currently has:

- transcript;
- artifacts gallery;
- files surface;
- image thumbnails;
- file download/open behavior.

### Proposed additions

For presented artifacts:

- show a transcript card: "Agent presented Pipeline Dashboard";
- include Open, Download, and View source actions;
- show path, version, and mime in details;
- pin presented artifacts above generic captured files.

For artifact apps:

- open in right-side pane or modal iframe;
- include reload and open-in-new-window controls;
- show a clear "generated app" boundary;
- expose version selector if multiple versions exist;
- show build/publish status if applicable.

For failures:

- show CSP/build/runtime error summary;
- let user download source;
- let user ask the agent to repair.

## Relationship to business data

Claude Artifacts can reportedly call Anthropic APIs and approved connectors through account-scoped infrastructure. Atrium can do something analogous, but should start with a stricter model.

### Static v1

No business data bridge. Apps can only use data embedded in the artifact files.

This is still useful. An agent can query business data during build time, produce a static dashboard/report, and publish that as an artifact. The artifact does not need live credentials.

Flow:

```text
agent uses approved tools/data access during session
    |
generates static artifact containing allowed output data
    |
Atrium serves static app with no live data access
```

### Read-only data bridge

Later, apps could request live data through Atrium:

```text
artifact app asks parent for dataset
    |
parent/server verifies app version, user, workspace, scopes
    |
server calls connector
    |
sanitized result returns to iframe
```

This requires:

- app identity;
- user consent;
- connector auth;
- scoped permissions;
- audit logging;
- rate limits;
- data-loss prevention policy.

### Write-capable bridge

Write access should come last. Generated apps that can mutate business systems are materially riskier.

For write actions, require:

- explicit user confirmation;
- clear action preview;
- server-side validation;
- idempotency keys;
- audit trails;
- revocable grants.

## Storage model

Claude-like `window.storage` is useful, but Atrium does not need it in v1.

Possible future API:

```js
await window.atrium.storage.set("filters", JSON.stringify(filters));
const filters = await window.atrium.storage.get("filters");
```

Design choices:

- personal storage versus shared storage;
- per-app quota;
- text-only values or typed blobs;
- whether storage is tied to app id or app version;
- last-write-wins versus optimistic concurrency.

Recommendation:

- app-level shared storage should be explicit and audited;
- personal storage can be per user/app;
- storage should go through the parent bridge, not browser localStorage.

## Capture and size implications

The current Centaur capture defaults are important.

Single-file HTML artifacts are easy until they include:

- React;
- charts;
- maps;
- large embedded data;
- large images;
- base64 assets.

A self-contained bundle can exceed 1 MiB. If it does, current capture may record only manifest metadata with no bytes, preventing preview.

Possible fixes:

- raise artifact capture caps for app paths;
- make app publish read directly from workspace storage;
- finish daemon-based capture with larger streaming support;
- prefer multi-file static apps over one giant HTML file;
- compress app assets at rest but serve decoded bytes.

The artifact app pipeline should not assume all generated apps are below 1 MiB.

## Deployment implications

The isolated app origin needs a deployment answer.

Possibilities:

1. subdomain:

   ```text
   https://apps.atrium.example/...
   ```

2. separate port/service in local development:

   ```text
   http://localhost:5174/...
   ```

3. same host but different site isolation domain through reverse proxy.

Same-origin path separation is not enough. Generated apps should not share Atrium's origin.

Local development may need:

- app origin env var;
- CORS/frame-ancestors config;
- signed token secret;
- reverse proxy route;
- local dev server for app-origin service.

## Unknowns

These are genuine unknowns after the repo review.

- How much of `notes/artifact-apps-plan.md` is already implemented elsewhere, if any.
- Whether Atrium wants artifacts primarily as per-session previews or durable workspace apps.
- Whether generated apps should ever run JavaScript from source, or always from compiled/published bundles.
- Which deployment environments can provide a separate app origin.
- Whether Centaur's current artifact cap can be raised safely for app paths.
- Whether the flat-home daemon capture path will replace the in-agent poll soon enough to target it directly.
- How much external network access generated apps should get, if any.
- Whether app artifacts should be reviewable/approvable before first execution.
- Whether artifact app versions should be immutable forever or garbage-collected with workspace retention.
- How app permissions should interact with workspace/channel/session visibility.
- Whether the first data bridge should be connector-based, artifact-ledger-based, or query-based.
- Whether a future React authoring path should support shadcn/Radix/Lucide/Recharts or a much smaller library set.

## Questions for product and engineering

1. Is the desired first milestone "preview this generated HTML" or "publish durable artifact apps"?
2. Should an agent be able to auto-open/present an artifact, or should the user always explicitly approve before execution?
3. Are artifact apps workspace-level objects, session-level objects, or both?
4. Should v1 allow any network requests from generated apps?
5. Is business-data access required in v1, or can agents embed a static data snapshot at build time?
6. Do we want React `.jsx` as a user-visible artifact type, or is "React project bundled to HTML" enough?
7. What library set should agents be allowed to rely on?
8. What is the expected maximum artifact app size?
9. Can production deployment provide a dedicated app origin?
10. Should generated apps be allowed to store user preferences?
11. Should apps be shareable outside the workspace?
12. Should app publish require review when generated from untrusted repo content?
13. Should artifacts be able to call agents later, or is that a separate "tools/apps" product?

## Recommended path

Build in this order:

1. Preserve current safe artifact file behavior.
2. Add an explicit `artifact.presented` contract.
3. Implement isolated single-file HTML preview on a separate origin.
4. Implement static app publishing from artifact ledger versions.
5. Add a Centaur skill for artifact app creation.
6. Add a complex app builder path that bundles projects into static apps.
7. Add optional `.jsx` source support by compiling to static app versions.
8. Add storage and data bridges only after app identity, versioning, and permissions are solid.

The practical first product can be simple:

```text
Agent writes shared/apps/foo/index.html.
Agent presents it.
Atrium opens it in a sandboxed iframe from an isolated origin.
```

That would capture most of the user-visible value of Claude Artifacts while fitting the architecture Atrium and Centaur already have.

## Code/doc reference map

Atrium:

- `notes/artifact-apps-plan.md` - existing static artifact app plan.
- `notes/artifact-file-types-design.md` - current file type UX and preview gaps.
- `notes/spike-artifact-store.md` - CAS ledger rationale.
- `notes/agent-data-architecture.md` - artifact/log/workspace architecture.
- `notes/shared-workspace-build-spec.md` - workspace-scoped artifacts and flat-home direction.
- `notes/flat-home-workspace-design.md` - flat-home target model.
- `notes/in-agent-poll-cutover-plan.md` - capture cutover status.
- `surface/server/src/session-runs.ts` - mirrors Centaur frames, records/offloads artifacts.
- `surface/server/src/artifact-ledger.ts` - workspace-scoped CAS artifact ledger.
- `surface/server/src/app.ts` - artifact serving routes and safe headers.
- `surface/server/src/artifact-offload.ts` - captured artifact byte offload worker.
- `surface/server/src/artifact-writeback.ts` - human/agent writes into artifact ledger.
- `surface/web/src/sessions/ArtifactsSurface.tsx` - artifact gallery UI.
- `surface/web/src/sessions/FilesSurface.tsx` - file content surface.
- `surface/centaur-client/src/reducer.ts` - client-side artifact event reducer.
- `surface/centaur-client/src/artifacts.ts` - artifact collection helper.

Centaur:

- `ARTIFACT_CAPTURE_SPEC.md` - artifact capture API/event spec.
- `ARTIFACT_CAPTURE_REPORT.md` - implementation report.
- `services/sandbox/artifact_capture.py` - current capture poller, allowlist, size caps, secret filtering.
- `services/sandbox/SYSTEM_PROMPT.md` - current sandbox prompt and artifact/file guidance.
- `services/sandbox/entrypoint.sh` - sandbox setup.
- `services/api-rs/crates/centaur-api-server/src/routes.rs` - artifact upload/download routes.
- `services/api-rs/crates/centaur-api-server/src/types.rs` - event name preservation.
- `services/api-rs/crates/centaur-session-core/src/lib.rs` - harness/session event model.
- `docs/pages/architecture.mdx` - Centaur architecture planes.
- `docs/pages/extend/skills.mdx` - skills model.

## Bottom line

Atrium should not try to clone Claude Artifacts by immediately building a `.jsx` iframe evaluator. The local architecture points to a safer and more durable design:

```text
captured files + artifact ledger + explicit presentation + isolated static app runtime
```

Once that is working, React artifacts become a build feature, not a runtime gamble:

```text
React source -> compile/bundle -> static app artifact -> isolated iframe
```

That path gets Atrium most of the visible Claude Artifacts experience while staying aligned with Centaur's sandbox model and Atrium's workspace artifact ledger.
