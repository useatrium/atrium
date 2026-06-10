# Phase 0 probe report

Run: 2026-06-10 16:48:40

- ✅ **A** execution completed — status=completed
- ✅ **A** result contains PONG — PONG
- ✅ **A** TTFE (execute->first event) — 0.02s
- ✅ **A** event histogram — {"execution_state/execution.state": 3, "execution_started/obs.execution_started": 1, "amp_raw_event/system": 1, "system_event_observed/obs.system": 1, "amp_raw_event/assistant": 2, "assistant_text_observed/obs.assistant_text": 2, "usage_observed/obs.usage": 1, "amp_raw_event/result": 1, "result_observed/obs.result": 1, "amp_raw_event/turn.done": 1, "execution_summary/obs.execution_summary": 1}
- ✅ **B** tool_use visible in event stream — 
- ✅ **B** tool_result visible in event stream — 
- ✅ **B** tool output roundtripped — 
- ✅ **B** execution completed — status=completed
- ✅ **B** TOOLCHAIN_OK in result — 
- ✅ **B** event histogram — {"execution_state/execution.state": 3, "execution_started/obs.execution_started": 1, "amp_raw_event/system": 1, "system_event_observed/obs.system": 1, "amp_raw_event/assistant": 4, "assistant_tool_use_observed/obs.assistant_tool_use": 2, "usage_observed/obs.usage": 2, "amp_raw_event/tool": 1, "tool_result_observed/obs.tool_result": 1, "assistant_text_observed/obs.assistant_text": 2, "amp_raw_event/result": 1, "result_observed/obs.result": 1, "amp_raw_event/turn.done": 1, "execution_summary/obs.execution_summary": 1}
- ✅ **C** events carry usable ids — 30/30 frames had ids
- ✅ **C** resumed ids non-decreasing, no non-terminal dupes — 413 ids span 77..489 bad_dupes=[]
- ✅ **C** replay deterministic (two cold replays identical) — replay1=413 frames replay2=413 frames
- ✅ **C** no live events missing from replay — 

**14/14 checks passed.**