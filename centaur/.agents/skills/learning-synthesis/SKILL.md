---
name: learning-synthesis
description: "Analyzes a day of Slack-thread user sessions to discover opportunities for new skills, personas, tools, workflows, and system-level improvements. Use alongside gap-analysis for the nightly self-improvement workflow."
---

# Learning Synthesis

Look across the day's sessions not for what went wrong, but for what the system could learn.

## Scope

Use this skill when the input is the same batch of reconstructed user tasks given to gap-analysis, and the goal is to find **opportunities** rather than **failures**.

Gap analysis asks: "what broke and how do we fix it?"
Learning synthesis asks: "what should we build, know, or become next?"

## What To Look For

Scan the evidence packs for these opportunity classes, in roughly this priority:

### 1. Missing Skills

A user repeatedly asks for a workflow or procedure the bot handles ad-hoc every time. If the same multi-step pattern shows up in 2+ threads, it should probably become a reusable skill with its own `SKILL.md`, references, and trigger phrases.

Look for:
- Multi-step procedures the bot assembled from scratch each time
- Tasks where the bot had to be walked through a process by the user
- Requests where a skill file would have saved significant back-and-forth

### 2. Missing Personas

A user needs a consistent stance, voice, or decision-making framework that doesn't match any existing persona. If the bot keeps being asked to "think like X" or "approach this from Y's perspective," that's a persona opportunity.

Look for:
- Repeated "think like a..." or "approach this as..." framing
- Tasks where the user had to repeatedly steer the bot's judgment or tone
- Domains where the existing personas (eng, legal, invest, events) don't cover the user's actual need

### 3. Domain Knowledge Gaps

The bot had to be taught something by the user that it should already know. If a user corrects the bot about internal processes, team structure, product names, or domain conventions, that knowledge should be baked into a skill, persona, or the system prompt.

Look for:
- User corrections that teach the bot internal facts
- "Actually, the way we do this is..." patterns
- Domain-specific vocabulary or conventions the bot didn't know

### 4. Tool Opportunities

Users are asking for capabilities that don't exist as tools. If users repeatedly ask the bot to do something it can only hack together with shell commands or workarounds, that's a tool opportunity.

Look for:
- Shell command workarounds for tasks that should be a proper tool
- "Can you access X?" where X isn't an integrated service
- Multi-step tool-call sequences that could be a single higher-level tool method

### 5. Workflow Automation

Users are doing manual multi-session workflows that could be automated. If you see a pattern like "every Monday the user asks the bot to do X, then Y, then Z," that's a scheduled workflow opportunity.

Look for:
- Recurring temporal patterns (daily, weekly, ad-hoc but regular)
- Multi-turn sessions that follow a predictable structure
- Tasks that a user shouldn't have to ask for because they're predictable

### 6. System Prompt Improvements

Sessions reveal that the base system prompt or a persona overlay is missing guidance that would prevent recurring confusion.

Look for:
- Cases where the bot misunderstood its role or capabilities
- Tasks where the bot didn't know about available tools or workflows
- Patterns where adding one line to the system prompt would prevent a class of mistakes

## Evidence Rules

Use the same evidence packs as gap-analysis. Do not request additional data.

Follow-up messages are provided as raw text. Interpret them semantically to understand what users actually needed, not just whether the task "passed" or "failed."

Focus on **patterns across sessions**, not individual task quality. A single instance is an anecdote; 2+ instances of the same demand pattern are a signal.

A separate reconciliation step will deduplicate your selected builds against gap-analysis fixes after this pass. Focus on finding the best opportunities; the workflow handles cross-pass merging.

## Output Contract

Return JSON only. Use EXACTLY these top-level keys:

```json
{
  "sessions_analyzed": 0,
  "opportunities_found": 0,
  "opportunities": [
    {
      "title": "Short descriptive title",
      "opportunity_type": "new_skill",
      "evidence_summary": "What sessions showed this pattern",
      "evidence_threads": ["C123:1700.100"],
      "what_exists_today": "How the bot handles this now",
      "what_should_exist": "What the improvement would look like",
      "target_surface": "tools/personas/eng/PROMPT.md",
      "implementation_sketch": "Concrete first step — not vague",
      "confidence": "high",
      "user_value": "Why this matters to users"
    }
  ],
  "selected_builds": []
}
```

### `opportunity_type` values

- `new_skill` — a reusable skill file for a recurring procedure
- `new_persona` — a new persona overlay for a recurring stance/voice
- `skill_improvement` — add references, examples, or steps to an existing skill
- `persona_improvement` — add guidance to an existing persona overlay
- `new_tool_idea` — a tool that should exist but doesn't
- `new_workflow_idea` — a scheduled or triggered workflow that should exist
- `system_prompt_improvement` — a change to the base system prompt
- `domain_knowledge` — factual knowledge that should be baked in somewhere

### `selected_builds` array

From the opportunities list, select up to the workflow-provided maximum for autonomous implementation. Each entry uses the same schema as `opportunities` but represents a commitment to build, not just an observation.

Only select builds where:
- The pattern appears in 2+ sessions (not a one-off)
- You can name a specific `target_surface` (file path)
- The implementation is small enough for one focused PR
- The user value is clear

Each selected build MUST additionally include a `slack_narrative` field — a 2–4 sentence plain-English note that names the specific users who surfaced the pattern, describes what they were trying to do, and explains why this opportunity is worth building now. Use the `source_user_name` field on each evidence pack to ground the narrative in real people. This field is posted to the internal `ai-v2` Slack channel and is stripped before the implementing agent sees the fix packet, so user names and concrete task details are encouraged here. Do NOT invent situations — stay grounded in provided evidence.

If no opportunity meets that bar, return an empty `selected_builds` array. Observations still go in `opportunities` for the scorecard.

## What Not To Do

- Do not duplicate gap-analysis findings. If something is a quality bug, it belongs in gap-analysis, not here.
- Do not propose vague "we should be smarter about X" recommendations. Every opportunity must have a concrete `target_surface` and `implementation_sketch`.
- Do not over-index on a single session. One user asking for something once is not a system-level opportunity.
