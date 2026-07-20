---
target: recent agent GUI / Agent Dock
total_score: 22
p0_count: 0
p1_count: 3
timestamp: 2026-07-19T17-50-26Z
slug: surface-web-src-sessions-agentdock-tsx
---
Method: dual-agent (A: agent_dock_design_review · B: agent_dock_evidence)

# Agent Dock Design Critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3/4 | Strong state chips and grouping; collapsed dots and silent mutation failures are weak. |
| 2 | Match system / real world | 2/4 | “Immerse,” “Filter,” “Clear,” and “Hibernating” do not precisely describe behavior. |
| 3 | User control and freedom | 3/4 | Collapse, Escape, resize/reset, and focus handoff are strong; bulk archive has no visible undo path. |
| 4 | Consistency and standards | 2/4 | A fullscreen-style icon hides navigation without expanding the dock; a filter retains nonmatches. |
| 5 | Error prevention | 2/4 | Resize is bounded and bulk archive confirms, but the minimum width still permits known truncation. |
| 6 | Recognition rather than recall | 2/4 | Icon-only controls and colored dots require users to learn meanings. |
| 7 | Flexibility and efficiency | 3/4 | Mod+., command palette, resize keys, and roving row navigation are excellent. |
| 8 | Aesthetic and minimalist design | 3/4 | Calm, dense hierarchy; the header is action-heavy and the resting rail is visually slack. |
| 9 | Error recovery | 1/4 | Pin/archive failures are swallowed and archived sessions disappear without in-dock recovery. |
| 10 | Help and documentation | 1/4 | Resize has a title, but icon-only dock actions lack visible contextual help. |
| **Total** |  | **22/40** | **Acceptable; significant improvements needed** |

## Anti-patterns verdict

This does not look like generic AI-generated UI. It is restrained, state-rich, and avoids gradients, glass, interchangeable card grids, and agent-magic decoration. The problem is product strangeness: standard-looking affordances do something subtly different from what a fluent user expects.

The deterministic detector returned no findings across `AgentDock.tsx`, `AgentDockRows.tsx`, and `Chat.tsx`. That is consistent with the absence of stylistic AI-slop patterns, but the detector cannot catch semantic mismatches such as an Expand icon that only hides another pane. Browser inspection was attempted but the browser runtime reported no available browser; targeted source and test evidence was used instead.

## Overall impression

The consolidation into one agent dock is strategically right, and the open state is the strongest part of the experience. The biggest opportunity is to make every spatial control and scope label tell the truth. Right now the intended peak—“Immerse”—is an anti-climax: the left navigation vanishes, the agent dock stays at its saved width, and chat remains the dominant canvas.

## What is working

1. One status vocabulary, attention-first ordering, workstream grouping, and transcript focus connect agents to real work rather than creating a generic Agents dashboard.
2. Interaction craft is unusually strong: layered Escape, responsive focus handoff, keyboard-operable resizing, roving row navigation, and reduced-motion handling.
3. Progressive disclosure is thoughtful: softened groups, History, the seven-day older fold, and readable two-line question payloads keep the monitor scannable.

## Priority issues

### [P1] False immersion/fullscreen affordance

**Why it matters:** On desktop, immersion sets the left wrapper to zero width while the agent dock remains at `--agent-dock-w`. The Expand icon implies enlargement, so users lose orientation without gaining agent workspace.

**Evidence:** `AgentDock.tsx:82`, `AgentDock.tsx:479`, `AgentDock.tsx:592`, and `Chat.tsx:2277`. The current test only asserts `md:w-0`, validating the implementation rather than the experience.

**Fix:** Choose one coherent contract. Preferred: make this an explicit focus mode in which the agent workspace expands and the left navigation becomes a 52px orientation rail with a clear restore action. If the intended action is only nav suppression, rename it “Hide navigation” or “Focus mode,” use a sidebar-collapse icon, preserve an orientation rail, and do not represent it as fullscreen.

**Suggested command:** `$impeccable layout` plus `$impeccable clarify`.

### [P1] Workstream/search/count controls do not tell the truth

**Why it matters:** “Filter agents to #…” retains nonmatching groups in a softened state; the headline count still includes them. With a workstream lens active, text search explicitly exempts the global Needs-you group. Users cannot predict the scope of the list or count.

**Evidence:** `AgentDock.tsx:347`, `AgentDock.tsx:362`, `AgentDock.tsx:440`, `AgentDock.tsx:627`, and `AgentDockRows.tsx:297`.

**Fix:** Decide whether this is a strict filter or a focus lens. For a strict filter, remove nonmatches and isolate global attention in a clearly labeled region. For a lens, label it “Focus: #channel” and show separate in-focus and elsewhere counts. Text search should filter every displayed row.

**Suggested command:** `$impeccable clarify` then `$impeccable polish`.

### [P1] “Hibernating” invents a lifecycle state

**Why it matters:** The selector derives the group solely from a `stalled` glance state. Calling that “Hibernating” makes a possible failure sound intentional and weakens agency legibility.

**Evidence:** `useAgentDock.ts:71` and `useAgentDock.ts:95`.

**Fix:** Rename the group “Stalled” or “Inactive,” show reason and elapsed time, and reserve “Hibernating” for a real controlled state with wake semantics.

**Suggested command:** `$impeccable clarify`.

### [P2] Resting spine is a vertically centered telemetry totem

**Why it matters:** The opener uses `md:flex-1`, centering the robot and dots in the whole rail. It breaks top-edge continuity with the left navigation and reads as decorative telemetry rather than persistent navigation/interruption infrastructure.

**Evidence:** `AgentDock.tsx:515`, especially the flex rule at `AgentDock.tsx:522`.

**Fix:** Top-anchor a 44–48px Agents opener, put its attention/live count directly below in a bounded cluster, and push New Agent to the bottom with `mt-auto`. Add a visible tooltip/label and non-color differentiation for status.

**Suggested command:** `$impeccable layout` plus `$impeccable audit`.

### [P2] Narrow rows and History recovery are fragile

**Why it matters:** The dock default was raised because 256px truncated questions, but users can still resize to 224px. Rows reserve substantial right-side space for actions and channel tags. “Clear” actually bulk-archives and mutation failures are swallowed.

**Evidence:** `useSessionPaneWidth.ts:388`, `AgentDockRows.tsx:176`, `AgentDock.tsx:182`, and `Chat.tsx:2882`.

**Fix:** Raise the minimum to the proven viable width or make row content adapt by hiding age first and moving secondary actions into overflow. Rename “Clear” to “Archive all…”, add undo/retrieval, and surface mutation failures.

**Suggested command:** `$impeccable harden` plus `$impeccable adapt`.

## Persona red flags

**Jordan, first-timer:** The unlabeled bot rail is not self-explanatory. Expand/Immerse removes navigation rather than expanding. “Hibernating” sounds intentional, and “Filter” leaves other groups behind.

**Alex, power user:** Mod+., arrow navigation, resizing, and the command palette are excellent. The spatial control violates learned desktop conventions, and ambiguous counts make rapid triage unreliable.

**Sam, accessibility-dependent:** Focus management and keyboard support are strong. The 10px metadata, color/pulse-only visible status dots, hover-hidden row actions, and missing visual tooltips remain concerns.

**Riley, stress tester:** The legal 224px width contradicts known truncation at 256px; query behavior bypasses Needs-you; bulk archive removes sessions without a dock-visible undo; persisted immersion can restore a nav-less shell.

## Cognitive load and emotional journey

The open dock has strong chunking and progressive disclosure. The header can expose more than four decisions at once—search, Mine/All, collapse, immerse, New agent, Triage, and clear-workstream—without a dominant local intent. The resting rail requires users to remember the bot and dot vocabulary.

The emotional peak should be entering a controlled agent-focused workspace. Instead, immersion currently produces disorientation: orientation disappears while the agent surface barely changes. Escape, collapse, and focus restore provide a reassuring exit, but persisting immersion can bring that disorientation back on reload.

## Minor observations

- The header total is a bare number with no visible scope label.
- Open/collapse should expose `aria-expanded` and `aria-controls`.
- Three adjacent icon-only header actions lack visual tooltips.
- New Agent is duplicated in the channel header and dock; clarify which surface owns creation.
- “Archive N terminal sessions?” does not say where those sessions can be recovered.

## Questions to consider

- Is “immersed” supposed to maximize the agent workspace or merely hide navigation?
- Is the 52px resting surface navigation, monitoring, or an interruption channel?
- Is a workstream selection a strict filter or a focus lens?
- Should Atrium imply an agent is peacefully “hibernating” when the only known fact is that work is stalled?
- Where does a user retrieve or undo sessions after “Clear”?
