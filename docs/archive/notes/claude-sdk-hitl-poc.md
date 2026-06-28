# Claude Agent SDK HITL POC

Base: Atrium `b972fd1` on worktree `/Users/garybasin/Code/atrium-wt-claude-sdk-poc`.

## Research Conclusions

- Atrium already has the product-side HITL flow: Centaur `question_requested` frames become `pendingQuestion`, the pane renders an input banner, and `/api/sessions/:id/answer` sends the answer back to Centaur.
- Claude's raw `claude -p --input-format stream-json` path is not enough for mid-turn answers. The Claude Agent SDK exposes `AskUserQuestion` through `canUseTool`, and the host must return `behavior: "allow"` with `updatedInput.questions` and `updatedInput.answers`.
- Claude's answer map is keyed by the literal question text, while Atrium/Centaur answers are keyed by a stable prompt id. The bridge needs a deterministic id mapping.
- `AskUserQuestion` supports `multiSelect`; multi-answer values are returned to Claude as comma-separated strings.
- Option previews are opt-in through `toolConfig.askUserQuestion.previewFormat`. `markdown` previews are ASCII/fenced-code style strings. `html` previews are styled `<div>` fragments. If the format is unset, previews are absent.

Sources:
- https://code.claude.com/docs/en/agent-sdk/user-input
- https://code.claude.com/docs/en/agent-sdk/typescript

## Atrium POC Shape

- `@atrium/centaur-client` now has `claudeQuestions.ts`, a dependency-free mapper from Claude SDK `AskUserQuestion` input into Atrium/Centaur `question_requested` frames and back into Claude's `updatedInput` result.
- Question prompts now carry `multiSelect`.
- Question options now carry optional `preview` and `previewFormat`.
- Web renders markdown previews as preformatted text and HTML previews inside a sandboxed iframe with a restrictive CSP.
- Mobile preserves multi-select answer arrays and renders preview content as compact preformatted text instead of executing HTML.

## Next Centaur Work

The remaining runtime work belongs in the Centaur harness layer:

1. Add a Claude SDK bridge process that catches `toolName === "AskUserQuestion"` in `canUseTool`.
2. Emit Atrium-compatible `question_requested` frames using the mapper shape here.
3. On answer, convert Atrium prompt-id answers back into Claude's question-text `updatedInput.answers`.
4. Use the SDK/hook defer-resume path for durable waits rather than a tmux/PTY fallback.
