# Atrium design foundation

This contract turns the audit into shared implementation decisions. Parallel lanes inherit it; they do not invent competing information architecture, language, or state semantics.

## Primary collaboration loop

**Communicate → attend → direct work → review outcomes.**

- **Chat** is where people establish context, discuss work, and start delegation.
- **Attention** contains only unseen or unresolved items that merit human awareness or intervention: mentions, DMs, agent questions, authentication problems, seat requests, failures or stalls, and newly completed work.
- **Agents** is the authoritative global overview of active and historical delegated work. Normal running work belongs here, not in Attention.
- **Session detail** is the contextual view of one delegated task. It can be reached from Chat, Attention, Agents, and an outcome, but does not create another global navigation model.
- **Outcomes** connect the request to decisions, changes, files, artifacts, unresolved issues, and the next useful action. Completion is more than a terminal transcript state.

## Attention semantics

| Category | Attention | Agents activity | Badge |
|---|---:|---:|---:|
| Running normally | No | Yes | No |
| Queued or spawning normally | No | Yes | No |
| Awaiting an answer | Yes | Yes | Yes until seen/resolved |
| Authentication required | Yes | Yes | Yes until seen/resolved |
| Seat request | Yes | Yes | Yes until seen/resolved |
| Failed or stalled | Yes | Yes | Yes until seen/resolved |
| Newly completed | Yes | Historical | Yes until seen |
| Completed and seen | No | Historical | No |
| Mention or DM | Yes | n/a | Yes until seen |

The client may pulse or animate Agents to indicate live progress, but it must not use danger styling or Attention counts for healthy running work.

## User-facing vocabulary

| Use | Avoid in product copy | Meaning |
|---|---|---|
| Chat | messages surface | Human and agent conversation in channels or DMs |
| Attention | Activity, Inbox when it includes normal work | Items that genuinely merit awareness or action |
| Agents | Sessions as a top-level label | Global delegated-work overview |
| Work | side effects as a broad category | What an agent did or produced |
| Changes | file mutations | Source or document modifications |
| Actions | What it ran | Commands and tools used |
| Files | artifacts when referring to ordinary files | Durable workspace files and versions |
| Results | terminal output | Outcome summary and produced work |
| Open details / Open session | Open pane | Reveal contextual session detail |
| Focus | full pane | Give one session the dominant work surface |

Technical terms may remain in expert inspection views when they convey real distinctions. Do not expose component names or layout implementation language.

## Layout hierarchy

- Present one dominant work surface and no more than one contextual secondary surface.
- Do not show both a duplicate agent preview and a sessions rail when the Agents destination already provides overview.
- Contextual session detail may be split, focused, detached, or closed, but transitions must preserve location and make the relationship to the originating conversation clear.
- Files may appear globally and within a session only when scope is visibly named.
- On compact surfaces, progressively disclose transcript, work, and results instead of compressing desktop panes.

## Platform contract

### Web

- Keep the compact sidebar, keyboard command center, deep links, contextual split view, and explicit focus treatment.
- Required controls remain available without hover.
- Validate 390, 768, 1024, and 1440 widths; 768 must not accidentally inherit an unusable desktop composition.

### Electron

- Inherit web content behavior but add deliberate native window, menu, shortcut, focus, zoom, popout, and theme-flash handling.
- Real-renderer E2E is required; a generated renderer stub is not visual evidence.

### iOS

- Preserve safe areas, edge-swipe Back, Dynamic Type, VoiceOver, system sheet and tab behavior, and 44 pt targets.
- Use system materials only where the platform component calls for them; do not hand-roll ornamental glass.

### Android

- Preserve edge-to-edge insets, IME behavior, predictive/system Back, Material type and color roles, TalkBack, and 48 dp targets.
- Adapt compact navigation to rail or drawer at expanded widths.

## Component and token contract

- Continue using the existing semantic color preferences and platform-adjusted contrast values.
- Treat numeric accent differences between web and native as deliberate contrast adaptations when they preserve the same semantic role.
- Use the `4 / 8 / 12 / 16 / 24` spacing and `6 / 10 / 14` radius scales before adding one-off values.
- Persistent structure uses tonal surfaces and one-pixel edges. Shadows are reserved for transient layers and direct manipulation.
- Complete important component states: default, hover or pressed, focus, active, selected, disabled, loading, empty, success, warning, error, offline, and recovery as applicable.
- Important status never relies on a dot or color alone.
- Metadata below 12px cannot be the only presentation of required information.
- Motion explains state or spatial relationship in roughly 150–250ms and has a reduced-motion alternative.

## First-run contract

First run is one connected activation path, not a collection of promotional cards:

1. Explain where the user is and the value of working with agents together.
2. Join or create a conversation.
3. Start a real or clearly labeled demo task from that context.
4. Observe one meaningful transition: starting, working, question, or completion.
5. Review the outcome and show where conversation, work, and files remain accessible.

Empty states include the next useful action when the user has permission to take it. Avoid uppercase eyebrows, generic hero cards, and duplicate teaching.

## Completion contract

A completed session should answer, at a glance:

- What was requested?
- What happened?
- What changed or was produced?
- What decisions or risks remain?
- What should the user do next?

The summary links to the transcript and detailed work rather than repeating them.

## Verification contract

- Web: axe or equivalent, keyboard/focus order, forced colors, high contrast, reduced motion, 125% type, and the required viewport matrix.
- Electron: real renderer, compact and expanded windows, 80/125/200% zoom, menus, shortcuts, focus restoration, theme, and multi-window behavior.
- Native: iOS and Android Maestro journeys for first run, navigation, active intervention, result review, settings, Back, offline/reconnect, and destructive recovery.
- Manual: VoiceOver and TalkBack through the primary loop, plus reviewed screenshot evidence for both account states.
