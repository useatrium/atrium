---
name: improve-gap-task
description: "Researches, plans, implements, validates, and opens a focused PR for one selected self-improvement gap. Use when executing one chosen backlog item from the nightly self-improvement workflow."
---

# Improve Gap Task

Execute one focused self-improvement fix from research through PR creation.

## Scope

Use this skill only when the workflow has already selected a single fix packet.

The workflow phases are fixed and must stay focused:

1. research
2. plan
3. implement
4. validate
5. open PR

Keep the work narrow. One selected backlog item should become one focused PR.

## Working Rules

- Start from the structured fix packet, not from a blank slate.
- Before editing, resolve the current repo slug and run `git-branch <owner/repo>` because the mounted repo is read-only.
- Match the change size to the root cause. Small fixes are great when the root cause is small; do not force a structural problem into a one-line prompt tweak just to keep the diff tiny.
- Prefer the fix that materially improves user outcomes. A focused 200-line workflow fix is better than a three-line prompt tweak that will not actually prevent the failure.
- Do not broaden scope into adjacent cleanup.
- `prompt_tweak` is a real tool but an over-prescribed one. Before committing to it, confirm that perfect prompt compliance would actually fix the failure. If the failure would recur even with the prompt read verbatim, choose a code, workflow, or tool fix instead.

## Phase Expectations

### Research

Produce a short structured answer covering:

- root cause (cite specific code, prompts, or patterns)
- affected files or prompts or skills
- acceptance criteria (how will we know this worked?)
- most likely fix type
- risks or unknowns
- verification plan (how to test the fix)

**Falsifiability rule:** If you cannot articulate how to verify the fix worked, the fix is speculative. Downgrade confidence and say so.

### Plan

Produce a short implementation plan covering:

- files to touch
- intended change (specific, not "improve the prompt")
- validation plan (exact commands or checks to run)
- PR title draft
- expected impact on the scored dimension(s)

### Implement

Make the change in the writable clone.

### Validate

Run the smallest relevant checks. Prefer targeted tests or repo checks over broad full-stack suites unless the change touches infra-wide behavior.

If the fix relies on a heuristic, regex, keyword trigger, or prompt wording
change, the validation phase must include adversarial examples:

- at least 5 positive examples that should now work
- at least 3 negative examples that should still be rejected
- at least 2 paraphrases that were not copied verbatim from the triggering task

Do not ship a prompt tweak or routing heuristic that only matches the exact
phrasing from the source thread.

### Open PR

Open one focused PR.

## Fix Type Selection: Decision Tree

Before committing to a fix type, work through this decision tree:

1. **Is this failure caused by the agent not knowing what to do, or not being able to do it?**
   - Not knowing what to do → `prompt_tweak`, `new_skill`, or `new_persona`
   - Not being able to do it → `bug_fix`, `tool_improvement`, or `workflow_fix`

2. **Does this failure pattern appear in 2+ reviewed tasks?**
   - One task only → likely cosmetic or one-off. Provide evidence why it is still worth fixing.
   - 2+ tasks → proceed; this is a systemic pattern.

3. **Can the fix be verified by re-running the failing scenario?**
   - Yes → proceed with verification plan
   - No → the fix is speculative. Downgrade priority.

4. **Does the fix risk regressing any currently-passing behavior?**
   - Yes → must include a regression check in the validation phase
   - No → proceed

5. **Is this a missing capability (recurring demand with no existing support)?**
   - Yes → `new_skill` (procedural, repeatable workflow) or `new_persona` (stance, style, decision framing)
   - No → `bug_fix`, `workflow_fix`, `prompt_tweak`, or `tool_improvement`

## Fix Type Rules

Allowed fix types:

- `bug_fix`
- `workflow_fix`
- `prompt_tweak`
- `tool_improvement`
- `new_skill`
- `new_persona`

Treat `new_skill` and `new_persona` as first-class fix types.

If the selected fix type is `new_skill` or `new_persona`, include an explicit justification answering all three questions:

1. Why is a new capability the right fix instead of a code, workflow, prompt, or tool change?
2. What recurring user demand pattern does this serve?
3. How would the new skill or persona be triggered and used?

Do not hand-wave this. Make the justification concrete and tied to evidence from the reviewed tasks.

## PR Quality

Write the PR like a senior engineer explaining a thoughtful improvement to
the codebase. The PR title and body are the public face of the self-improvement
loop — they should be clear, well-reasoned, and useful to a reviewer.

### PR body structure

Use this structure:

```
## Summary
1-3 bullet points: what changed and why.

## Problem
Explain the failure pattern or capability gap that motivated this fix.
Describe the root cause concretely — cite the specific code, prompt, or
workflow behavior that was wrong or missing. Do NOT describe individual
user sessions, tasks, thread contents, or conversations.

## Fix
Explain the change and why it addresses the root cause. A reviewer who
has never seen the gap-analysis output should understand the reasoning.

## Verification
What checks were run. Include command output summaries where useful.
```

### Privacy rules (critical)

The PR body, title, and commit messages must NEVER contain:

- User names, user IDs, Slack handles, or email addresses
- Specific Slack thread content, quotes from user messages, or thread URLs
- Task IDs, thread keys, or any identifier that maps to a specific user session
- Company names, project names, or internal jargon from user conversations

Frame everything in terms of the **system behavior** that was wrong, not the
**user interaction** where it was observed. For example:

- Good: "The agent fails to use handoff when approaching the context limit"
- Bad: "User @alice asked for a robotics market map and the agent hit the context limit"

If you need to cite evidence, describe the **pattern** ("3 of 5 reviewed tasks
hit the context limit without using handoff") not the **specific sessions**.

The upstream gap-analysis / learning-synthesis pass separately emits a
`slack_narrative` that DOES name users and sessions — that narrative is used
only for the internal `ai-v2` scorecard post and is stripped from the
`fix_packet` before it reaches you. If you somehow receive a `slack_narrative`
field, ignore it entirely and never echo it into the PR or commits. Every
name, handle, and thread reference you see anywhere in your context is
treated as private.

## PR Handoff Contract

The PR body must stay concise and human-readable. Use labels as the required machine-readable handoff:

- `self-improve`
- `fix-type:<type>` where `<type>` is the selected fix type

After opening the PR, verify with `gh pr view` that the required labels are present.
Do NOT add a hidden HTML-comment metadata block. Source-thread notification is best-effort only and may be unavailable when a PR body intentionally omits private thread metadata.

## Output Contract

Return JSON only in each phase.

### Research output

```json
{
  "root_cause": "",
  "fix_type": "workflow_fix",
  "affected_files": [""],
  "acceptance_criteria": [""],
  "verification_plan": [""],
  "risks": [""],
  "confidence": "high",
  "new_capability_justification": ""
}
```

### Plan output

```json
{
  "files": [""],
  "plan": [""],
  "validation": [""],
  "pr_title": "",
  "expected_impact": ""
}
```

### Implement output

```json
{
  "changed_files": [""],
  "summary": ""
}
```

### Validate output

```json
{
  "checks": [
    {
      "command": "",
      "status": "passed"
    }
  ],
  "summary": "",
  "regression_check": ""
}
```

### Open PR output

```json
{
  "branch": "",
  "commit": "",
  "pr_number": 0,
  "pr_url": "",
  "pr_title": "",
  "verified_handoff": true
}
```

## Reference Files

- Read `references/history.md` for the intervention log format and prior fix context.
