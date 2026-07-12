---
name: Atrium
description: The living workshop where teams work with agents together.
colors:
  workshop-black: "#09090b"
  raised-zinc: "#18181b"
  overlay-zinc: "#27272a"
  edge-zinc: "#3f3f46"
  primary-ink: "#f4f4f5"
  body-ink: "#e4e4e7"
  muted-ink: "#8f8f98"
  indigo-action: "#4f46e5"
  indigo-hover: "#6366f1"
  danger: "#dc2626"
  warning: "#f59e0b"
  success: "#10b981"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.indigo-action}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.indigo-hover}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.workshop-black}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  panel:
    backgroundColor: "{colors.raised-zinc}"
    textColor: "{colors.body-ink}"
    rounded: "{rounded.md}"
    padding: "12px"
---

# Design System: Atrium

## Overview

**Creative North Star: "The Living Workshop"**

Atrium is a focused shared workspace in which conversation and active work remain visibly connected. Its base is restrained and operational, but not inert: presence, progress, intervention, and completion introduce purposeful signs of life. The interface should help users feel amplified by coordinated human and agent work while keeping responsibility and control legible.

The system favors compact hierarchy, precise controls, tonal layers, and small moments of physical feedback. A subtle lift is permitted when an element temporarily moves above the workspace—menus, dialogs, lightboxes, dragged objects, and focused editors—but ordinary content remains grounded. Atrium explicitly rejects the generic AI-dashboard vocabulary of decorative gradients, interchangeable card grids, ornamental glass, vague agent magic, and glow used as a substitute for information.

**Key Characteristics:**

- Restrained, state-rich color with one scarce action accent.
- Dense but scannable product typography using the platform's familiar sans-serif.
- Tonal panels and dividers for persistent structure; controlled lift for transient layers.
- Precise, responsive controls with visible hover, focus, active, disabled, loading, and error states.
- Shared conceptual hierarchy with platform-native navigation, targets, typography scaling, and system behavior.

## Colors

The palette is zinc-black and paper-white with an indigo action signal; semantic colors communicate state, never decoration.

### Primary

- **Indigo Action** (`#4f46e5`): Primary actions, active selection, focus emphasis, and the most important live state. Keep it scarce.
- **Indigo Response** (`#6366f1`): Hover and active feedback for Indigo Action, plus restrained progress emphasis.

### Neutral

- **Workshop Black** (`#09090b`): Dark canvas and the deepest persistent surface.
- **Raised Zinc** (`#18181b`): Sidebars, panels, fields, and content raised one structural level.
- **Overlay Zinc** (`#27272a`): Pressed controls, selected neutral rows, and nested utility surfaces.
- **Primary Ink** (`#f4f4f5`): Headings and high-emphasis labels on dark surfaces.
- **Body Ink** (`#e4e4e7`): Default readable text.
- **Muted Ink** (`#8f8f98`): Secondary metadata that still clears AA contrast on the dark canvas.

### Named Rules

**The One Live Signal Rule.** Indigo identifies action, selection, focus, or genuinely active work. Do not spend it on decoration.

**The Semantic State Rule.** Danger, warning, success, and information colors must pair with language, icons, or shape; color never carries status alone.

**The Theme Parity Rule.** Dark, light, high-contrast, and user-selected accents are authored states, not transformations applied after the primary design.

## Typography

**Display Font:** Platform UI sans-serif
**Body Font:** Platform UI sans-serif
**Label/Mono Font:** Platform monospace only for code, identifiers, diffs, and technical values

**Character:** Familiar and quiet enough to disappear into the task, with weight and spacing doing the hierarchical work. Web and desktop use the system sans stack; native uses system text roles and respects user scaling.

### Hierarchy

- **Headline** (600, 20px web): Major surface titles and focused empty-state prompts; rare inside dense workflows.
- **Title** (600, 17px web): Pane titles, dialog titles, and important grouped content.
- **Body** (400, 15px web/native base): Conversation, explanations, and primary readable content, generally capped near 70ch for prose.
- **Label** (600, 13px): Buttons, tabs, compact headers, and control labels.
- **Metadata** (400–600, 11–12px): Timestamps, status, and secondary context; never required for the only statement of an important state.

### Named Rules

**The Working Scale Rule.** Product hierarchy stays within a compact 1.125–1.2 ratio. Large display typography does not belong inside the authenticated workspace.

**The Native Type Rule.** iOS uses Dynamic Type roles and Android uses the Material type scale. Do not reproduce web pixel sizes literally on native.

## Elevation

Atrium uses a hybrid system: tonal layering and borders define persistent structure, while a subtle physical lift marks transient layers or direct manipulation. Persistent panels should not all become shadowed cards. Menus, dialogs, popovers, lightboxes, dragged items, and focused authoring surfaces may use small, crisp shadows that clearly explain overlap.

### Shadow Vocabulary

- **Transient Low** (`0 4px 8px rgb(0 0 0 / 18%)`): Menus, compact popovers, and hover-lifted draggable objects.
- **Transient High** (`0 12px 24px rgb(0 0 0 / 22%)`): Dialogs, lightboxes, and full authoring overlays.

### Named Rules

**The Grounded Workspace Rule.** Persistent panes and ordinary content are separated by tone, spacing, or a one-pixel edge. Shadows appear only when an element truly occupies a higher interaction layer.

## Components

Components are precise and responsive: compact where pointer and keyboard input allow it, comfortably target-sized on touch, and complete across interaction states.

### Buttons

- **Shape:** Small radius (`6px`) for compact controls; full pills only for tags, toggles, and circular icon actions.
- **Primary:** Indigo Action with white or verified on-accent text; one primary action per local decision area.
- **Hover / Focus:** Immediate color response and a visible two-pixel focus treatment. Focus must never rely on color shift alone.
- **Secondary / Ghost:** Neutral surface or transparent background with readable text; use borders only where the control boundary would otherwise be ambiguous.
- **Native:** At least `44×44 pt` on iOS and `48×48 dp` on Android, using platform controls where a standard control exists.

### Chips

- **Style:** Compact, fully rounded status or filter affordances. Semantic chips use a tinted surface plus readable text and an icon or label.
- **State:** Selected chips carry stronger tone and explicit selected semantics; static statuses must not look tappable.

### Cards / Containers

- **Corner Style:** `10px` default and `14px` for large standalone media or authoring surfaces.
- **Background:** Tonal surface roles before borders or shadows.
- **Shadow Strategy:** Grounded at rest; only lifted when transient or manipulated.
- **Border:** One-pixel semantic edges where adjacent tones do not provide enough separation.
- **Internal Padding:** `12px` compact, `16px` normal, `24px` for sparse standalone states.

### Inputs / Fields

- **Style:** Darkest available input surface inside a raised pane, one-pixel edge, `6–10px` radius, and clear placeholder contrast.
- **Focus:** Stronger edge plus an outer focus indicator that survives high-contrast mode.
- **Error / Disabled:** Error includes message and semantics; disabled remains readable and visibly noninteractive rather than merely faded.

### Navigation

Web and desktop use a compact sidebar, pane headers, tabs, and keyboard shortcuts with clear active state and persistent location context. Mobile uses platform-aware stack and top-level navigation, preserves system Back behavior, and adapts navigation structure for compact versus expanded widths. Navigation labels should remain visible unless space or a universally understood platform convention strongly justifies icons alone.

### Session Work

Session state, current actor, questions, approvals, work products, and intervention points form Atrium's signature component family. They must read as one evolving workstream rather than a stack of unrelated cards. State transitions should remain visible, reversible where possible, and connected to the conversation or artifact that caused them.

## Do's and Don'ts

### Do:

- **Do** make actor, status, current action, and available intervention legible in every active-work surface.
- **Do** use the `4 / 8 / 12 / 16 / 24px` spacing scale and `6 / 10 / 14px` radius scale before adding one-off values.
- **Do** preserve familiar product and platform affordances, especially keyboard focus, system Back, sheets, menus, switches, and destructive confirmation.
- **Do** validate every important component in dark, light, high-contrast, increased font scale, and reduced-motion modes.
- **Do** use motion between `150–250ms` to explain state change, spatial relationship, or direct manipulation.

### Don't:

- **Don't** make Atrium feel like a generic AI dashboard: no decorative gradients, interchangeable card grids, ornamental glass, vague agent-magic language, or gratuitous AI glow.
- **Don't** reduce agents to bots bolted onto ordinary chat; connect agent state, decisions, changes, and artifacts to the collaboration that produced them.
- **Don't** use shadows on every pane or combine a wide soft shadow with a decorative one-pixel card border.
- **Don't** hide required actions behind hover-only behavior or undersized touch targets.
- **Don't** use color as the only indicator of status, selection, error, authorship, or presence.
- **Don't** port web controls directly to native or force one platform's navigation and modal conventions onto the other.
