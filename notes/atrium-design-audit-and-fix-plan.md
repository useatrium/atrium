# Atrium design audit and fix plan

## Decisions

- Aim for a noticeable evolution of Atrium's visual language without discarding the product structure or rebuilding the interface from scratch.
- Audit both a clean first-run account and a populated power-user workspace.
- Validate native mobile behavior separately on iOS and Android.
- Perform all audit and implementation work in dedicated branches and worktrees. Do not modify the primary checkout.
- Use Impeccable v3.9.1 for design context, critique, deterministic checks, and polish guidance.
- Use agent-fanout only after the audit backlog and shared design foundation have been reviewed.

## North-star quality hurdle

Atrium is done when it feels like one deliberate, trustworthy collaboration product across web, desktop, iOS, and Android: a new user can orient themselves and complete the primary workflow without coaching, an experienced user can move quickly without the interface getting in their way, and no surface feels like a secondary port or a collection of individually styled features.

The subjective review question is:

> If a design-conscious user moved between Atrium's web app, desktop app, and both native mobile apps for a full working day, would every important moment feel coherent, clear, calm, and intentionally resolved—or would they encounter anything that feels improvised, inconsistent, generic, fragile, or unfinished?

The pass is complete only when the honest answer is that nothing important breaks that illusion of a single, mature product.

This is intentionally a hurdle rather than a numeric score. Automated checks prevent known defects; the hurdle requires judgment about trust, coherence, and craft.

## Reusable goal prompt

> Audit and noticeably evolve Atrium's complete user experience across web, Electron desktop, iOS, and Android. Preserve the product's restrained, task-first identity and existing strengths while making every important workflow feel coherent, clear, calm, trustworthy, and intentionally resolved. Cover both first-run and populated power-user states, including empty, loading, success, failure, offline, destructive, permission, accessibility, responsive, and platform-specific behavior. Work only in dedicated branches and worktrees. Establish and review a shared design foundation before using agent-fanout for disjoint implementation lanes. Do not stop at passing tests or visual consistency: continue until a design-conscious user could work across every surface for a full day without encountering anything that feels improvised, inconsistent, generic, fragile, or secondary. Every change must earn its place, avoid redundancy, preserve standard affordances, and pass functional, accessibility, cross-platform, and visual QA.

## Definition of done

The subjective hurdle is supported by these observable gates:

1. **Orientation:** A first-time user can identify where they are, what Atrium is doing, and the next useful action without explanation.
2. **Flow:** The primary loop—find or create a conversation, collaborate with people or agents, understand session progress, and inspect or act on resulting work—has no confusing handoffs or dead ends.
3. **Power:** Frequent actions remain fast for experienced users through appropriate density, keyboard behavior, shortcuts, persistence, and predictable controls.
4. **Coherence:** Equivalent concepts share hierarchy, language, interaction states, and visual vocabulary across platforms. Platform-specific conventions are deliberate exceptions, not drift.
5. **Parity:** No supported surface feels neglected. Desktop-specific window behavior and iOS/Android conventions are validated independently.
6. **State completeness:** Important components handle default, hover or pressed, focus, active, selected, disabled, loading, empty, success, warning, error, offline, and recovery states where applicable.
7. **Accessibility:** Keyboard navigation, focus order, screen-reader semantics, contrast, font scaling, touch targets, reduced motion, and high-contrast preferences work in representative workflows.
8. **Resilience:** Long text, localization pressure, slow networks, reconnects, missing media, partial data, and destructive actions do not make the interface collapse or become ambiguous.
9. **Restraint:** The pass removes inconsistency and friction without adding duplicate controls, decorative noise, gratuitous motion, or unnecessary card-like containers.
10. **Evidence:** The final matrix contains reviewed screenshots and test results for both account states, all supported themes and accessibility modes, representative viewport and device sizes, and every major workflow.
11. **Quality gate:** Workspace lint, typecheck, unit tests, web Playwright E2E, Electron E2E, mobile accessibility lint, and Maestro flows on both iOS and Android pass.
12. **Independent review:** A final Impeccable critique and audit find no unresolved P0/P1 issues. Any remaining P2/P3 finding is explicitly accepted with a reason rather than silently deferred.

## Phase 1: isolated setup

- Fetch the latest `origin/master`.
- Create a uniquely named integration worktree and branch from that remote commit.
- Keep the primary checkout untouched until a reviewed pull request is ready.
- Create persistent child worktrees only when implementation fan-out begins.
- Warm each worktree with the required ignored dependencies and local environment inputs without copying build outputs.

## Phase 2: product and design context

- Run Impeccable initialization for Atrium and capture the audience, product register, tone, references, and anti-references in `PRODUCT.md`.
- Extract the current visual system into `DESIGN.md`.
- Inventory web and mobile colors, typography, spacing, radii, elevation, semantic states, motion, focus treatment, icons, and accessibility preferences.
- Identify which concepts should remain shared and which should follow native platform conventions.
- Document current strengths before proposing additions or replacements.
- Check every proposal for duplication, unnecessary bulk, and conflict with established workflows.

The current foundation already includes paired light and dark themes, accent variants, high contrast, font scaling, and reduced-motion preferences. Web tokens are primarily defined in `surface/web/src/index.css`; mobile tokens are primarily defined in `surface/mobile/src/lib/theme.ts`. The pass should reconcile and evolve this foundation instead of creating a competing system.

## Phase 3: coverage matrix and fixtures

Prepare both a clean first-run account and a seeded power-user workspace. Include representative channels, direct messages, active and completed agent sessions, questions, approvals, artifacts, file changes, conflicts, voice content, calls, errors, and empty states.

Audit these workflow families:

- Authentication, first run, onboarding, recovery, and reconnection.
- Navigation, channels, direct messages, search, activity, agents, files, and settings.
- Chat timeline, composer, mentions, reactions, threads, attachments, voice, and calls.
- Agent sessions, plans, questions, approvals, reasoning, suggestions, changes, side effects, and conflicts.
- Artifact browsing, supported preview types, markup editing, version history, divergence, and apply flows.
- Empty, loading, populated, success, warning, failure, offline, destructive, and permission-denied states.
- Light, dark, high-contrast, accent variants, font scaling, reduced motion, keyboard navigation, focus order, screen readers, text overflow, and localization pressure.

Validate across:

- Web at desktop, tablet, and narrow viewport widths.
- Electron menus, window sizes, popouts, deep links, native shortcuts, title behavior, and multi-window state.
- iOS on compact and large device classes.
- Android on compact and large device classes.

## Phase 4: independent audit

Run two isolated assessments so deterministic findings do not anchor the subjective review:

1. **Design assessment:** Evaluate hierarchy, information architecture, clarity, density, cognitive load, emotional journey, discoverability, consistency, copy, edge cases, and generic or AI-generated design signals.
2. **Evidence assessment:** Run Impeccable's detector, live browser inspection, accessibility checks, responsive checks, and screenshot capture against representative surfaces.

Synthesize the results into:

- A Nielsen heuristic scorecard.
- A platform and workflow parity map.
- A component, token, language, and interaction divergence report.
- A prioritized P0-P3 issue backlog.
- Explicit `preserve`, `refine`, and `evolve` decisions.
- A list of rejected changes that would add redundancy or visual bulk.

Review this synthesis before implementation begins.

## Phase 5: shared foundation

Complete one serial foundation phase before parallel work:

- Normalize semantic tokens and component states.
- Define shared interaction, copy, accessibility, and responsive expectations.
- Resolve web/mobile naming and behavioral drift.
- Record intentional platform exceptions.
- Establish visual fixtures and seeded audit states.
- Add regression coverage for shared behavior.
- Commit the reviewed foundation to the integration branch so every implementation lane inherits it.

## Phase 6: agent-fanout implementation

Use persistent, disjoint worktrees with precise file ownership. A likely split is:

1. **Web shell and communication:** Navigation, channels, chat, threads, composer, activity, settings, and responsive structure.
2. **Web sessions and artifacts:** Session pane, work drawer, plans, questions, changes, side effects, files, previews, markup, and conflicts.
3. **Native navigation and communication:** iOS/Android navigation, login, channels, search, chat, threads, composer, voice, and calls.
4. **Native sessions and artifacts:** Session and work sheets, approvals, plans, changes, artifacts, previews, markup, and media.
5. **Desktop shell:** Electron-only menus, windows, popouts, deep links, title behavior, and platform integration. Embedded web UI remains owned by the web lanes.

Each runner must:

- Touch only its assigned files and functions.
- Inherit the committed foundation.
- Run exact targeted tests and perform screenshot-based visual QA.
- Report its changes, evidence, and known gaps.
- Avoid commits so the orchestrator can review the complete staged patch.
- Be stopped and rejected if it writes outside scope or makes destructive changes.

## Phase 7: integration and regression

- Review every staged patch, including new files, before applying it to the integration branch.
- Run targeted tests after each applied lane.
- Resolve shared-component conflicts centrally rather than delegating overlapping ownership.
- Recheck cross-platform parity after every major integration.
- Perform a unified polish pass for typography, spacing, language, motion, focus behavior, error handling, and long-content behavior.

## Phase 8: final quality gate and delivery

From the integration worktree:

- Run workspace lint, migration checks, typechecks, and unit tests.
- Run the full Surface Playwright E2E suite.
- Run Electron Playwright E2E.
- Run mobile accessibility lint.
- Run Maestro flows on iOS and Android.
- Manually verify keyboard and screen-reader behavior in primary workflows.
- Review the final screenshot matrix across platforms, states, themes, accessibility modes, and representative sizes.
- Run final Impeccable critique, audit, and polish passes.
- Compare the product against the north-star quality hurdle, not merely the test results.

Once all gates pass, commit on the integration branch, push it, and open a pull request into `master` with a Conventional Commit title. Do not merge unless required CI is green.

## Scope discipline

- This is an Atrium surface pass; avoid unrelated Centaur runtime changes.
- Preserve existing successful workflows and component behavior unless evidence supports changing them.
- Prefer the smallest coherent fix that solves the demonstrated problem.
- Do not use visual novelty to conceal unclear product structure.
- Do not declare completion because the planned files were touched. Declare it only when the experience clears the quality hurdle and the evidence supports that judgment.
