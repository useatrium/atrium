# Centaur Durable Event Stream — Observed Schema (Phase 0)

Captured 2026-06-10 against Centaur `contrib/chart 0.1.49`, harness `claude-code`,
via `GET /agent/threads/{thread_key}/events?execution_id=&after_event_id=`.
Source dumps: `A_pong.jsonl`, `B_tooltest.jsonl`, `C_first.jsonl`/`C_rest.jsonl`,
`D_replay.jsonl` (450+ frames analyzed). This is the contract the Phase-2 session
pane renders against.

## Frame envelope

Every SSE frame: `event:` name + `data:` JSON. Every frame carries a strictly
increasing integer id (durable row id in `agent_execution_events`) — exposed as
`event_id` in our probe dumps. Reconnect with `after_event_id=<last seen>`
resumes with zero loss; a finished execution replays identically (verified
byte-identical across two cold replays) and re-emits the terminal
`execution_state` snapshot at stream end.

## Event inventory (event name / data.type, counts across dumps)

| event | data.type | count | role |
|---|---|---|---|
| `execution_state` | `execution.state` | 13 | lifecycle: `queued` → `running` → terminal (`completed`/`failed_permanent`…). Terminal frame carries `result_text`. |
| `execution_started` | `obs.execution_started` | 5 | projection: engine, harness, user_id, persona |
| `amp_raw_event` | `system` | 4 | harness init (`subtype:"init"`, `session_id`) |
| `system_event_observed` | `obs.system` | 4 | projection of the above |
| `amp_raw_event` | `assistant` | 234 | **the content stream**: `message.content[]` blocks (text or tool_use). Streaming deltas arrive as successive assistant frames; complete message follows with `uuid` + full `message` |
| `assistant_text_observed` | `obs.assistant_text` | 232 | projection per text frame |
| `assistant_tool_use_observed` | `obs.assistant_tool_use` | 2 | projection: `tool_name`, `input` |
| `amp_raw_event` | `tool` | 1 | tool result: `content[].content` (output text), `is_error` |
| `tool_result_observed` | `obs.tool_result` | 1 | projection: `is_error`, engine/harness |
| `usage_observed` | `obs.usage` | 5 | `model`, `cost_usd` per assistant message |
| `amp_raw_event` | `result` | 4 | final turn text |
| `result_observed` | `obs.result` | 4 | projection |
| `amp_raw_event` | `turn.done` | 4 | `result`, `turn_id` |
| `execution_summary` | `obs.execution_summary` | 4 | `models[]`, `status` |

## Raw vs projection

Each `amp_raw_event` is paired with an `obs.*` projection frame. **Renderers
should consume raw frames for content** (they carry the Anthropic-format
message blocks verbatim) and projections for metadata/metrics (tool_name
without parsing blocks, cost_usd, engine/harness). Projections are stable
across harnesses (the API normalizes via `normalize_harness_event`); raw
payload shape follows the harness's native stream (Anthropic format for
claude-code).

## Text streaming granularity — PER-DELTA ✅

LONGSTREAM run (200 mock deltas): 200 single-token raw `assistant` frames plus
one final aggregated message → **1.005 events per model delta**. A live pane
can render true token-level streaming straight off the durable stream. (Cost:
each delta is also a durable Postgres row — fine at Phase-2 scale; revisit
compaction for production.)

## Tool-call lifecycle (B_tooltest, event_ids 55–76)

```
55 execution.state status=queued
56 execution.state status=running
57 obs.execution_started        engine=claude-code user_id=probe
58 amp_raw_event/system         subtype=init session_id=<uuid>
60 amp_raw_event/assistant      message.content[0] = {type:"tool_use", id, name:"Bash",
                                 input:{command}}          ← streaming frame
62 amp_raw_event/assistant      complete message (uuid, msg id, stop_reason)
61,63 obs.assistant_tool_use    tool_name="Bash", input={command:...}
64 obs.usage                    model, cost_usd
65 amp_raw_event/tool           content[0].content = "<stdout>", is_error=false
66 obs.tool_result              is_error=false
67-70 assistant text (raw+obs, streaming then complete)
72 amp_raw_event/result         text = final answer
74 amp_raw_event/turn.done      result, turn_id
75 obs.execution_summary        models[], status=completed
76 execution.state              status=completed, result_text=<final>
```

## Renderer contract (minimal set for the session pane)

- **Status chip**: `execution_state.status` (`queued`/`running`/terminal);
  terminal frame's `result_text` for the completion card.
- **Streaming text**: `amp_raw_event` where `data.type=="assistant"` and
  `data.message.content[]` has `{type:"text"}` blocks → append `text`.
  Frames with `data.uuid` are the complete-message form — use to reconcile/
  replace accumulated deltas for the message.
- **Tool card open**: `amp_raw_event` assistant frame with `tool_use` block →
  card with `name` + `input` (or use `obs.assistant_tool_use.tool_name/input`).
- **Tool card result**: `amp_raw_event` where `data.type=="tool"` →
  `content[0].content` (string output), `is_error`.
- **Cost/usage ticker**: `obs.usage.cost_usd`, `obs.usage.model` (cumulative).
- **Completion summary**: `turn.done.result` or terminal
  `execution_state.result_text`; `obs.execution_summary.models`.
- **Resume**: persist last `event_id`; reconnect `after_event_id=<it>`; expect
  possible duplicate terminal `execution_state` (dedupe by id, allow
  execution_state dupes).
