# Atrium design audit report

Method: dual-agent (A: `/root/design_assessment` · B: `/root/evidence_assessment`)

## Executive judgment

Atrium does not broadly look AI-generated. It has a disciplined zinc palette, scarce accent, dense system typography, real operational states, and accessibility intent that reaches into implementation. The product already does the hard conceptual work of exposing agent plans, questions, turns, changes, side effects, files, artifacts, and intervention.

It does not yet feel like one resolved product across surfaces. The primary information architecture makes conversation, agents, sessions, attention, and artifacts compete for ownership. Mobile labels all active agents as Inbox attention and presents five equal destinations inside an ornamental floating glass bar. First-run education is split among passive empty states and a generic card. Desktop is still primarily the web renderer inside an Electron window rather than a deliberately resolved desktop experience.

The fix pass should preserve the visual foundation and rich state model while evolving the organization around a simple loop:

> **Communicate → attend → direct work → review outcomes.**

## Design health score

Scores use `0 = failed` and `4 = excellent`.

| # | Nielsen heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | Rich status exists, but mobile badges overstate urgency by counting all active sessions. |
| 2 | Match between system and real world | 2 | Activity/Inbox, Agents/sessions, panes, turns, and side effects expose implementation terminology. |
| 3 | User control and freedom | 3 | Strong back, close, retry, cancel, detach, and recovery; some mobile fallback navigation is silent. |
| 4 | Consistency and standards | 1 | Navigation, naming, agent/session locations, and platform treatments diverge materially. |
| 5 | Error prevention | 3 | Disabled and destructive states are generally strong; some discovery depends on long press or icon-only controls. |
| 6 | Recognition rather than recall | 2 | Agent/session/work actions are distributed across too many competing surfaces. |
| 7 | Flexibility and efficiency | 3 | Web power use is strong; duplicated navigation and previews reduce efficiency. |
| 8 | Aesthetic and minimalist design | 2 | Restrained foundation, but pane competition, glass navigation, tiny uppercase labels, and card scaffolding add noise. |
| 9 | Error recovery | 3 | Recovery is usually actionable; boot, workspace, and session errors sometimes lose specificity. |
| 10 | Help and documentation | 2 | Contextual teaching exists, but there is no coherent first-run activation journey. |
| **Total** |  | **24/40** | **Capable foundation; focused structural evolution required.** |

## Anti-pattern verdict

The core product UI is not generic AI slop. Two mobile patterns clearly violate Atrium's stated anti-reference:

1. `surface/mobile/src/components/GlassTabBar.tsx` implements an ornamental “Liquid-Glass” capsule with blur, a 22px radius, border, large shadow, and elevation. It looks identical on iOS and Android and is the clearest AI-era design tell.
2. `surface/mobile/app/(app)/(tabs)/sessions.tsx` presents first run as a centered bordered card with a tiny uppercase tracked `FIRST RUN` eyebrow—the generic generated-product scaffold the design system explicitly rejects.

The Impeccable detector scanned all 184 web source assets and found three warnings, all contextual false positives:

- `side-tab` at `surface/web/src/markup/MarkupEditor.css:69` is a semantic document blockquote, not a decorative card stripe.
- `overused-font` at `surface/web/src/markup/MarkupEditor.css:123` is a comment pseudo-element fallback, not the product type system.
- `border-accent-on-rounded` at `surface/web/src/sessions/WorkDrawer.tsx:72` resolves onto a `rounded-none` tab.

These should receive narrow inline suppressions or detector configuration so future scans retain signal.

## What is working

### Operational legibility

Agents are not reduced to chat bubbles. Atrium exposes state, plans, questions, turns, changes, side effects, files, artifacts, and intervention. That is the product's most important advantage and must survive the pass.

### Accessibility infrastructure

Skip navigation, visible focus, live regions, reduced-motion handling, modal focus restoration, mobile screen-reader actions, high contrast, font preferences, and touch-target work appear throughout the code. The remaining problem is verification breadth and several inconsistent edge implementations, not absence of intent.

### Restrained foundation

The neutral palette, compact system type, shared spacing and radius scales, scarce accent, and semantic status colors are right for sustained technical work. This pass should reconcile and refine them, not introduce a replacement visual system.

## Priority backlog

### P1 — Unify the primary information architecture

**Evidence:** web exposes a global Agents destination, Sidebar Agents preview, optional Sessions rail, contextual session pane, and a six-tab Work Drawer. Mobile exposes Agents and Inbox as equal top-level destinations while also surfacing session work contextually.

**Why it matters:** users must choose between conversation, agents, sessions, attention, and artifacts before they can act. Density is acceptable; competing organizational models are not.

**Foundation decision:**

- Conversation is where work begins and context is discussed.
- Attention contains only actionable or newly relevant work.
- Agents is the authoritative overview for ongoing and historical delegated work.
- A session is contextual detail, not another global destination model.
- Outcomes connect the completed session to decisions, changes, files, and artifacts.
- Remove or consolidate duplicate previews and rails when they do not add a distinct scope.

### P1 — Make “needs attention” semantically true

**Evidence:** mobile derives `activeAgents` from every nonterminal session and uses it for both the Agents pulse and Inbox badge. Activity also merges normal running work into attention.

**Why it matters:** running normally is not the same as awaiting a person. False urgency creates anxiety and trains users to ignore badges.

**Foundation decision:** introduce explicit presentation categories for `active`, `awaiting input`, `failed or stalled`, `newly completed`, and `seen`. Badges count only unseen actionable work. Normal progress may animate or pulse on Agents without entering Inbox.

### P1 — Replace ornamental mobile glass navigation

**Evidence:** `GlassTabBar.tsx` uses decorative blur, translucency, a heavy capsule, shadow, and elevation on both operating systems.

**Why it matters:** it conflicts with the product brief, consumes depth on compact screens, and makes Android feel like a port.

**Foundation decision:** retain visible labels but use platform-aware navigation surfaces. iOS should feel native to its tab/navigation material and safe areas; Android should use Material roles, elevation, and compact/expanded navigation patterns. Do not create two unrelated information architectures.

### P1 — Prove responsive and accessible behavior in real renderers

**Evidence:** web has no axe/contrast/forced-colors suite or visual regression. Responsive evidence is largely source and class assertions. Native has one iOS Maestro happy path and no Android journey coverage. Desktop E2E uses a stub renderer.

**Why it matters:** the definition of done names keyboard, screen reader, contrast, scaling, reduced motion, platform behavior, and representative sizes. Current tests cannot prove those claims.

**Foundation decision:** add a representative browser accessibility and viewport matrix, real-renderer desktop coverage, and iOS/Android Maestro flows before declaring the redesign complete.

### P2 — Design one connected first-run loop

**Evidence:** mobile Chat says `No channels yet` without an embedded next action, Agents uses a promotional first-run card, and web teaches agent invocation separately in the Sessions rail.

**Fix:** guide the user through joining or creating a conversation, starting or inviting work, observing one meaningful transition, and reviewing one outcome. Keep teaching contextual and progressively disclosed.

### P2 — Reduce desktop pane competition

**Evidence:** a populated desktop can show a dense sidebar, channel, thread or session pane, Sessions rail, and nested Work Drawer tabs.

**Fix:** maintain one dominant work surface and at most one contextual secondary surface. Remove the Sidebar Agents preview or Sessions rail where the global Agents destination already owns overview. Make peek, split, focus, detach, and close transitions spatially predictable.

### P2 — Normalize user-facing language

**Evidence:** Activity versus Inbox; Agents versus sessions; `Open pane`; `What it ran`; `Side effects`; internal route and component vocabulary leaks into UI.

**Fix:** adopt a glossary centered on `Agents`, `Attention`, `Work`, `Changes`, `Files`, `Results`, and user-directed verbs. Never show “pane” in product copy. Document deliberate technical terms that remain.

### P2 — Give session completion an outcome

**Evidence:** completed work remains primarily a transcript, list item, or rail state. The payoff is weaker than the rich active-work experience.

**Fix:** close the emotional loop with a compact outcome summary connecting what was requested, what changed, artifacts produced, unresolved decisions, and the next useful action.

### P2 — Resolve Electron as a desktop surface

**Evidence:** the shell fixes a minimum width of 880px, uses a dark initial background regardless of preferences, and has primarily macOS-specific chrome behavior. Automated E2E does not run the real renderer.

**Fix:** prevent theme flash, validate compact windows, focus restoration, zoom, menus, shortcuts, popouts, and multi-window behavior against the real renderer. Record Windows/Linux scope explicitly if they ship.

### P3 — Retire repetitive micro-scaffolding

Reduce repeated tiny uppercase tracked headings, hover-only disclosure, mixed emoji/Ionicon glyphs, and metadata below a comfortable size where it communicates required state. Preserve compactness through hierarchy and spacing rather than administrative labels.

## Persona red flags

- **First-time team lead:** Chat, Files, Agents, Inbox, and Search appear before Atrium's primary collaboration loop is established.
- **Mobile approver:** Inbox counts ordinary running work, obscuring what actually needs intervention.
- **Agent-heavy power user:** Sidebar Agents, Sessions rail, session pane, work tabs, and Activity can all compete simultaneously.
- **Low-vision user:** important metadata can fall to 10–11px and frequent truncation; real 125% and assistive testing is missing.
- **Android user:** the iOS-flavored floating glass capsule and modal language feel ported rather than adaptive.
- **Self-hosted newcomer:** server configuration dominates the first encounter before the product demonstrates value.

## Preserve, refine, evolve

### Preserve

- Zinc neutral foundation, semantic accents, system typography, and compact working density.
- Conversation-to-session linkage and the rich inspectable agent state model.
- Accessibility infrastructure and preference support.
- Web keyboard fluency, command palette, deep links, popouts, and persisted drafts.

### Refine

- Status taxonomy and badge semantics.
- Empty, loading, failure, and recovery specificity.
- Metadata scale, truncation, localization pressure, and icon consistency.
- Cross-surface nouns and verbs.
- Completion summaries and emotional closure.

### Evolve

- Cross-platform IA into `communicate → attend → direct work → review outcomes`.
- Mobile navigation into platform-aware adaptive treatments.
- First run into a connected activation journey.
- Electron into a deliberately tested desktop shell.
- Session completion from transcript-centric to outcome-centric.

## Evidence backlog

1. Add authenticated web viewport coverage at 390, 768, 1024, and 1440 widths in dark/light, 125% type, reduced motion, and high contrast.
2. Add axe or equivalent checks for login, chat, open session, spawn, work drawer, files, and settings; add focus-order and forced-colors checks.
3. Add iOS and Android Maestro flows for login/first run, navigation, active-session intervention, question or approval, steering, cancellation, artifacts, settings, system Back, and offline recovery.
4. Run Electron Playwright against the real built renderer and validate zoom, actual keyboard navigation, multi-window focus, theme, and compact-window behavior.
5. Add representative visual regression for first run, dense power-user, loading, error, offline, attention, conflict, and completion states.
6. Verify important metadata and controls at maximum font scale, long localized strings, VoiceOver, TalkBack, and coarse pointers.

## Rejected additions

- Do not add another dashboard, overview rail, or agent-summary card; the product already has overlapping overview surfaces.
- Do not use more badges, pulses, or color to solve unclear attention semantics.
- Do not turn every session state into a card.
- Do not add ornamental glass, gradients, AI glow, or decorative motion to make the product feel alive.
- Do not force exact pixel parity between web, iOS, and Android; preserve conceptual parity and native behavior.

## Run notes

- Target: complete Atrium UI under `surface/`.
- Ignore list: none present.
- Assessment independence: confirmed; A did not receive detector output and B did not receive A's review.
- CLI detector: complete web source scan, 184 assets, 3 warnings, all contextual false positives.
- Browser visibility and overlay: unavailable during Assessment B because package-level worktree dependencies were not yet present; no overlay or screenshot was claimed.
- Live server cleanup: renderer startup failed immediately; no assessment server remained.
- Fallback evidence: source inspection, 89 web Vitest files, existing Playwright suites, 41 mobile Vitest files, mobile accessibility lint, Maestro inventory, Electron unit/E2E inventory.
- Temp files: none created by the assessments.
