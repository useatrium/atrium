# Atrium design audit matrix

This matrix is the evidence ledger for the design audit and fix pass. A row is complete only when both account states have been reviewed, applicable accessibility modes have been exercised, and the evidence path is recorded. Source inspection alone does not prove a rendered or interactive requirement.

## Required account states

- **First run:** clean account, default preferences, no meaningful channel history, no active sessions, and no user-created artifacts.
- **Power user:** multiple channels and DMs, unread activity, concurrent active and completed sessions, questions and approvals, artifacts and versions, conflicts, voice content, calls, failures, and offline/recovery history.

## Required presentation modes

- Dark and light themes.
- High contrast.
- Every supported accent, with indigo as the reference capture.
- Default and maximum supported font scale.
- Full and reduced motion.
- Pointer/keyboard and coarse-pointer behavior where applicable.
- VoiceOver on iOS and TalkBack on Android for the primary loop.

## Platform matrix

| Platform | Required sizes | Native concerns | Evidence status |
|---|---|---|---|
| Web | 1440×1000, 1024×768, 768×1024, 390×844 | keyboard, focus order, hover-independent actions, responsive panes, browser zoom | Pending |
| Electron macOS | compact and expanded windows; main and popout | menus, shortcuts, deep links, multi-window state, title behavior, zoom | Pending |
| iOS | compact iPhone and large iPhone; one iPad width | safe areas, edge-swipe Back, Dynamic Type, VoiceOver, sheets, 44 pt targets | Pending |
| Android | compact phone and expanded/tablet width | system/predictive Back, edge-to-edge insets, IME, Material navigation adaptation, TalkBack, 48 dp targets | Pending |

## Workflow evidence ledger

| Workflow | First run | Power user | Error/recovery | Accessibility | Existing automated evidence | New evidence required |
|---|---:|---:|---:|---:|---|---|
| Login and server connection | Pending | Pending | Pending | Pending | Web login E2E coverage is embedded in helpers and chat setup | Explicit invalid-server, auth failure, retry, native login, and screen-reader captures |
| Initial orientation and empty workspace | Pending | n/a | Pending | Pending | Limited source/unit evidence | First-run screenshots and task walkthrough on every platform |
| Global navigation and current location | Pending | Pending | Pending | Pending | Web routing, addressability, discoverability, responsive tests; desktop menu smoke | Native navigation/Back flows and focus/screen-reader order |
| Channels and DMs | Pending | Pending | Pending | Pending | Web chat, realtime, tenancy, read-position tests | Native populated/empty captures and offline/recovery walkthrough |
| Search and command center | Pending | Pending | Pending | Pending | Web search and command-center E2E | Empty/no-result/error states; native search and assistive semantics |
| Timeline and message actions | Pending | Pending | Pending | Pending | Web message, reaction, thread, action-sheet, touch, copy, broadcast tests | Native VoiceOver/TalkBack actions; long text and localization stress |
| Composer, attachments, and offline queue | Pending | Pending | Pending | Pending | Web upload, offline send/edit/reaction, retry, disconnect tests | Native IME/insets, attachment errors, disabled/loading states, recovery captures |
| Voice messages and calls | Pending | Pending | Pending | Pending | Web call recovery E2E; source/unit coverage | Native permission denial, interruption, incoming/active/rejoin, assistive labels |
| Agents and session discovery | Pending | Pending | Pending | Pending | Web Agents addressability and session-list E2E | First-run explanation, native navigation, high-density state, error recovery |
| Spawn and configuration | Pending | Pending | Pending | Pending | Web repo-spawn and provider auth E2E | Validation hierarchy, mobile sheet behavior, keyboard/screen-reader flow |
| Active session and transcript | n/a | Pending | Pending | Pending | Web pane, stream, popout, reconnect, transcript action tests | Native complete flow; long-running/high-volume state; status comprehension |
| Questions, approvals, suggestions, and steering | n/a | Pending | Pending | Pending | Web disconnect question recovery; component/unit coverage | Full decision-state matrix, native semantics, timeout/rejection/recovery |
| Plans, reasoning, and turn state | n/a | Pending | Pending | Pending | Component/unit coverage | Visual hierarchy and cognitive-load comparison across platforms |
| Changes, side effects, and conflicts | n/a | Pending | Pending | Pending | Web conflict E2E and component tests | Native resolution flow, long diff/file names, partial failure, focus order |
| Files hub and gallery | Pending | Pending | Pending | Pending | Broad web Files E2E including ACL, versions, edits, previews | Empty/no-access/error states; native parity; tablet and assistive review |
| Media and document previews | n/a | Pending | Pending | Pending | Web renderer/component tests and selected Files E2E | Cross-format visual captures, missing/corrupt/large media, native controls |
| Markup authoring and application | n/a | Pending | Pending | Pending | Web markup reply/response/stale-base E2E | Native complete flow, keyboard/focus order, conflict/recovery captures |
| Settings and preferences | Pending | Pending | Pending | Pending | Web Settings addressability/unit coverage | Theme/contrast/font/motion visual matrix; native controls and persistence |
| Notifications and activity | Pending | Pending | Pending | Pending | Web Activity navigation and realtime behavior indirectly covered | Empty grouping, high volume, stale/deep-link behavior, native badge semantics |
| Desktop windows and popouts | n/a | Pending | Pending | Pending | Electron smoke and manual QA checklist | Compact/expanded visual captures, focus restoration, failure and multi-window cases |

## Current automation baseline

### Strong existing evidence

- Web collaboration, realtime synchronization, read position, routing, deep links, offline queueing, reconnect healing, files, conflicts, and session panes have meaningful Playwright coverage.
- Electron has a focused Playwright smoke test for menus, popout deduplication, and new windows.
- Web components have extensive Vitest coverage, including accessibility primitives.
- Mobile runs a dedicated accessibility lint gate.

### Known evidence gaps before assessment synthesis

- Native end-to-end coverage currently consists of one Maestro comment-on-message flow.
- There is no checked-in screenshot matrix spanning the required account, theme, contrast, font, motion, viewport, and device states.
- Existing functional tests do not by themselves prove visual hierarchy, cognitive load, platform-native behavior, or screen-reader task completion.
- Desktop visual behavior outside the smoke path relies primarily on a manual checklist.

## Completion record

For each completed row, link or list:

1. The exact fixture or seed command used.
2. Screenshot paths for required platform and presentation modes.
3. Automated test names and result artifacts.
4. Manual keyboard and assistive-technology notes.
5. Findings raised and the commit or accepted-risk record that resolves each one.
