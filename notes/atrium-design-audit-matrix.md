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
| Web | 1440×1000, 1024×768, 768×1024, 390×844 | keyboard, focus order, hover-independent actions, responsive panes, browser zoom | Automated partial — `surface/e2e/tests/design-audit.spec.ts` passed all 7 tests across all four sizes, document overflow, required shell controls, representative keyboard focus, themes, contrast, text scale, reduced motion, empty states, dense data, and terminal Results; browser zoom and full focus order remain pending |
| Electron macOS | compact and expanded windows; main and popout | menus, shortcuts, deep links, multi-window state, title behavior, zoom | Partial runtime evidence — the real packaged renderer smoke passes at the 420×480 compact floor, captures the retryable offline/auth state, verifies native menus and zoom commands are exposed, and exercises popout deduplication plus New Window; expanded visual review, actual zoom rendering, focus restoration, and high contrast remain pending |
| iOS | compact iPhone and large iPhone; one iPad width | safe areas, edge-swipe Back, Dynamic Type, VoiceOver, sheets, 44 pt targets | Compact iPhone runtime evidence obtained on iPhone 17 / iOS 26.5 for authenticated launch, all top-level destinations, empty search, appearance/accessibility settings, demo result, message send, long-press actions, and thread navigation. Large iPhone, iPad, edge swipe, and VoiceOver remain manual gaps |
| Android | compact phone and expanded/tablet width | system/predictive Back, edge-to-edge insets, IME, Material navigation adaptation, TalkBack, 48 dp targets | API 36 ARM64 phone emulator/toolchain installed and booting with `adb`; dependency CMake configuration currently stops the native build with `Can't infer shell!`, so journey, predictive Back, expanded layout, and TalkBack remain unverified |

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

### Web design-audit evidence lane

`surface/e2e/tests/design-audit.spec.ts` uses the isolated `atrium_e2e` database, the real authenticated web app, existing login/API helpers, and a direct E2E session fixture consistent with the existing session specs. Screenshots are attached to the Playwright report rather than committed as pixel baselines.

| Evidence | State and modes proved | Playwright attachments | Remaining gap |
|---|---|---|---|
| Login, shell, and global navigation | Clean account at 390×844, 768×1024, 1024×768, and 1440×1000; Search, shortcuts, Files, Agents, and Attention are visible; compact navigation is operable without hover | `empty-phone-shell` | Invalid server/auth/retry, browser zoom, exhaustive focus order, and screen-reader task completion |
| Empty orientation destinations | Clean account Attention, Agents, Files, and Settings rendered; empty Attention copy and basic body contrast checked | `empty-attention`, `empty-agents`, `empty-files`, `settings-default` | A connected first-run activation journey does not exist in the current fixture/product flow |
| Populated collaboration | API-seeded dense `#general` timeline, uploaded text artifact, populated Files, and completed agent session | `dense-chat`, `populated-agents`, `populated-files` | The required full power-user fixture (DMs, approvals, conflicts, voice/calls, failures, and recovery history) is not safely seedable as one current helper |
| Terminal outcome | Completed E2E session opens in the real session surface with visible terminal `Results` and completion language | `terminal-results` | Failed/cancelled outcomes, decisions/risks, rich changes, and produced-artifact linkage |
| Preferences and accessibility | Light, dark, high contrast, 125% text, and reduced motion are applied through Settings and asserted on the rendered document; representative global-nav and Settings controls have computed focus indicators; deterministic primary text/control contrast checks | `settings-light`, `settings-dark`, `settings-high-contrast-125-reduced` | Every accent, forced colors, full keyboard order, axe/screen-reader coverage, and manual assistive-technology review |

The lane is intentionally partial evidence: it does not mark a workflow row complete because the ledger requires both full account states and all applicable accessibility modes.

Validation in this worktree on 2026-07-11: `pnpm --filter @atrium/e2e typecheck` passed. A clean isolated-port run on server `3117`, web `5287`, and Centaur stub `18117` passed all 7 Playwright tests in 16.8 seconds with one worker. The named screenshots were produced as transient Playwright attachments; they remain report artifacts rather than committed pixel baselines. The lane is strong representative browser evidence, but it does not substitute for the unexecuted full cross-platform matrix below.

### Native Maestro evidence lane

`surface/mobile/.maestro/` contains shared selector-based flows plus separate iOS and Android journeys for authenticated launch, all five top-level destinations, empty search, light/dark/high-contrast/XL-text/reduced-motion settings, the deterministic demo-agent result, message sending, long-press actions, thread replies, and Android system Back behavior. The previous coordinate-based flow was removed. Runtime testing corrected invalid subflow headers and replaced stale or unsupported claims about deterministic steering and message comments with paths the app actually exposes.

Maestro 2.6.1, OpenJDK 17, Xcode, CocoaPods, Android command-line tools, and an API 36 ARM64 image were installed locally. The iOS development build compiled and ran on an iPhone 17 / iOS 26.5 simulator after clearing a worktree-path-bound Expo Swift cache and using simulator signing for keychain access. Questions, approvals, authentication failures, artifacts, cancellation/recovery, offline/reconnect, VoiceOver, and TalkBack remain explicitly unverified; see `surface/mobile/.maestro/README.md` for the exact device matrix and reset/run procedure.

### Desktop evidence lane

The Electron production builds completed and `surface/desktop/e2e/desktop-smoke.spec.ts` passed against the real renderer on macOS. The run verified a theme-appropriate launch background, the 420×480 compact floor, mounted React UI, native menu structure, Files navigation, session-popout deduplication, and New Window. Its reviewed compact screenshot showed the retryable sign-in/network failure state with clear hierarchy and an operable primary action. Electron's role-based zoom commands are asserted in the menu, but automated shortcut activation did not change the zoom factor in this headless harness, so actual zoomed rendering remains a manual evidence gap rather than an overstated pass.

### Final verification summary (2026-07-11)

Landing review update (2026-07-12): the branch was rebased onto current `origin/master` and a web integration regression was corrected so archived sessions remain excluded while the new Session/Attention language is preserved. Workspace lint, migration naming, and all package typechecks pass. Serial unit reruns pass 91 web files / 518 tests, 44 mobile files / 148 tests, and 102 server files / 660 tests; shared, centaur-client, and desktop lanes also pass. The full browser run completed 77/82 while Android compilation was saturating the host; one failure exposed and fixed a stale `Search sessions` audit selector, and all five failed cases plus the related message-action tests passed in an isolated 7/7 rerun. Web and Electron production builds pass, as does the real-renderer desktop smoke (1/1). Mobile accessibility lint passes. iOS runtime evidence and the remaining Android build blocker are recorded above; VoiceOver, TalkBack, large native layouts, and the broader manual matrix remain explicit gaps rather than claimed passes.

- Workspace migration filename check and all seven package typechecks passed.
- Workspace unit run passed 5 package lanes; the concurrent web/mobile lanes each produced one 5-second timeout, and both affected files passed immediately in isolated single-worker reruns (9/9 web and 6/6 mobile).
- Full web Playwright ran all 80 tests serially: 76 passed in the complete run. The four failures were two stale labels introduced by the deliberate Inbox → Attention and pane → details language changes, plus two timing failures. After updating the stale expectations, all four exact tests passed in isolated reruns. The design-audit lane itself passed 7/7 in both the complete and focused runs.
- Electron production web/desktop builds passed; the real-renderer Electron smoke passed 1/1 after correcting the smoke harness to satisfy Playwright's fixture contract.
- Mobile accessibility lint passed, and focused mobile navigation/work-surface tests passed 9/9.
- The release hurdle is **not yet cleared**: iOS and Android runtime journeys, VoiceOver/TalkBack, and the remaining full keyboard/reflow/assistive matrix have not been executed.

### Strong existing evidence

- Web collaboration, realtime synchronization, read position, routing, deep links, offline queueing, reconnect healing, files, conflicts, and session panes have meaningful Playwright coverage.
- Electron has a focused Playwright smoke test for menus, popout deduplication, and new windows.
- Web components have extensive Vitest coverage, including accessibility primitives.
- Mobile runs a dedicated accessibility lint gate.

### Known evidence gaps before assessment synthesis

- Native end-to-end coverage now has nine selector-based Maestro YAML files spanning shared setup plus three iOS and three Android journeys, but none has been executed in this environment.
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
