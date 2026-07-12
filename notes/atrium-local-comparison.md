# Atrium local design comparison

This review environment compares the design branch against its exact common ancestor (`3ddce901`), not against a newer moving `master`. That keeps the comparison attributable to the design pass.

## Live local URLs

| Version | Web | API | Database |
|---|---|---|---|
| Before | http://127.0.0.1:5373 | http://127.0.0.1:3201 | `atrium_design_baseline` |
| Design pass | http://127.0.0.1:5374 | http://127.0.0.1:3202 | `atrium_design_redesign` |

Sign in to each with handle `design-review` and display name `Design Review`. The databases are isolated and contain matching synthetic messages, channels, and completed/running/failed agent sessions.

## Guided comparison

1. **Login:** Open each URL in a fresh/private browser context. Compare the product claim, hierarchy, field labels, and disclosure of server configuration.
2. **Populated Chat:** In `#general`, compare the workspace navigation and right-side session context. The design pass removes the duplicate agent-session list from the left sidebar and labels the contextual right rail `Agent work`.
3. **Global work:** Open **Agents**. Confirm normal running work is discoverable there without being styled as an alert.
4. **Human attention:** Compare **Inbox** before with **Attention** after. The revised language is deliberately limited to mentions, questions, failures, authentication, seat requests, and recent completion awareness rather than ordinary healthy progress.
5. **Terminal outcome:** Open `Audit launch readiness`. In the design version, inspect the explicit terminal **Results** summary instead of treating the transcript ending as the only completion signal.
6. **First-run state:** Sign out and use a new handle in both versions. Compare the empty Chat and Agents explanations and their next-action clarity.
7. **Preferences:** In Settings, compare light/dark, high contrast, 125% text, and reduced motion. Keyboard-tab through the global navigation and form controls.
8. **Responsive behavior:** Resize both windows to 390×844, 768×1024, and 1024×768. Check navigation access, horizontal overflow, composer usability, and session detail behavior.

## What this preview proves

- It is safe: no production services or data are used.
- Both sides use the same synthetic scenario and independent databases.
- The baseline is the exact pre-design commit, so unrelated later changes are excluded.

It does not prove native iOS/Android behavior or assistive-technology completion; those remain separate simulator/device gates in the audit matrix.

## Future team-shareable preview

The durable next step is an ephemeral per-branch deployment with a disposable database and object-storage namespace, seeded by the same deterministic fixture. It should be access-controlled, carry an obvious non-production banner, expire automatically, and expose paired baseline/design links in the pull request. Do not point a preview at production Postgres, MinIO, LiveKit, or credentials.
