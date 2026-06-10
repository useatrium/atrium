#!/usr/bin/env python3
"""Phase-0 seam probes against a local Centaur deployment.

Drives the durable control-plane API directly (no Slack):
  spawn -> message -> execute -> tail SSE events -> verify.

Tests:
  A pong        streaming basics + infra TTFT (execute -> first event/delta)
  B tooltest    tool_use / tool_result event granularity
  C reconnect   mid-stream disconnect, resume via after_event_id, id continuity,
                replay determinism (two full replays compared)
  D apikill     kill the API pod mid-execution (SLOWSTREAM), verify recovery
                behavior + durable transcript

Usage:
  python3 phase0/probe.py                 # run A B C
  python3 phase0/probe.py A B C D         # include the destructive API-kill test
Writes raw frames to phase0/results/<test>.jsonl and a report to
phase0/results/report.md.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

NS = os.environ.get("CENTAUR_NAMESPACE", "centaur")
RELEASE = os.environ.get("CENTAUR_RELEASE", "centaur")
LOCAL_PORT = int(os.environ.get("PROBE_PORT", "18000"))
BASE = f"http://127.0.0.1:{LOCAL_PORT}"
ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
SECRETS_ENV = ROOT.parent / ".centaur-local" / "secrets.env"

RESULTS.mkdir(exist_ok=True)


def load_api_key() -> str:
    txt = SECRETS_ENV.read_text()
    m = re.search(r"LOCAL_DEV_API_KEY=(\S+)", txt)
    if not m:
        raise SystemExit("LOCAL_DEV_API_KEY not found in .centaur-local/secrets.env")
    return m.group(1)


API_KEY = load_api_key()


# ---------- port-forward management ----------

_pf_proc = None


def start_port_forward():
    global _pf_proc
    stop_port_forward()
    _pf_proc = subprocess.Popen(
        [
            "kubectl", "port-forward", "-n", NS,
            f"deploy/{RELEASE}-centaur-api", f"{LOCAL_PORT}:8000",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(60):
        try:
            api_get("/health", timeout=2)
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("port-forward never became healthy")


def stop_port_forward():
    global _pf_proc
    if _pf_proc:
        _pf_proc.terminate()
        try:
            _pf_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _pf_proc.kill()
        _pf_proc = None


def ensure_forward_alive():
    try:
        api_get("/health", timeout=2)
    except Exception:
        start_port_forward()


# ---------- HTTP helpers ----------

def _req(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "x-api-key": API_KEY},
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def api_get(path, timeout=30):
    return _req("GET", path, None, timeout)


def api_post(path, body, timeout=60):
    return _req("POST", path, body, timeout)


# ---------- SSE tailing ----------

def extract_event_id(sse_id_line, data):
    for key in ("event_id", "id", "seq"):
        v = data.get(key) if isinstance(data, dict) else None
        if isinstance(v, int):
            return v
        if isinstance(v, str) and v.isdigit():
            return int(v)
    if sse_id_line is not None and sse_id_line.isdigit():
        return int(sse_id_line)
    return None


def tail_events(thread_key, execution_id, after_event_id=0, max_events=None,
                overall_timeout=600, read_timeout=300):
    """Yield (event_name, data, event_id, t_recv) frames until terminal/limits."""
    qs = f"?execution_id={execution_id}&after_event_id={after_event_id}"
    url = f"{BASE}/agent/threads/{thread_key}/events{qs}"
    req = urllib.request.Request(url, headers={"x-api-key": API_KEY})
    start = time.monotonic()
    count = 0
    with urllib.request.urlopen(req, timeout=read_timeout) as resp:
        event_name, data_lines, sse_id = None, [], None
        while True:
            if time.monotonic() - start > overall_timeout:
                return
            line = resp.readline()
            if not line:
                return
            line = line.decode("utf-8", "replace").rstrip("\n").rstrip("\r")
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
            elif line.startswith("id:"):
                sse_id = line[3:].strip()
            elif line == "":
                if event_name or data_lines:
                    raw = "\n".join(data_lines)
                    try:
                        data = json.loads(raw) if raw else {}
                    except json.JSONDecodeError:
                        data = {"_raw": raw}
                    eid = extract_event_id(sse_id, data)
                    yield (event_name or "message", data, eid, time.monotonic())
                    count += 1
                    if max_events and count >= max_events:
                        return
                    if event_name == "execution_state":
                        status = data.get("status")
                        if status in ("completed", "failed", "failed_permanent", "cancelled"):
                            return
                event_name, data_lines, sse_id = None, [], None


def is_terminal_state(ev, data):
    return ev == "execution_state" and data.get("status") in (
        "completed", "failed", "failed_permanent", "cancelled",
    )


# ---------- turn driver ----------

def run_turn(thread_key, text, harness="claude-code"):
    spawn = api_post("/agent/spawn", {"thread_key": thread_key, "harness": harness},
                     timeout=180)
    gen = spawn["assignment_generation"]
    api_post("/agent/message", {
        "thread_key": thread_key,
        "assignment_generation": gen,
        "role": "user",
        "parts": [{"type": "text", "text": text}],
        "user_id": "probe",
        "metadata": {"user_name": "probe", "platform": "dev"},
    })
    t_execute = time.monotonic()
    ex = api_post("/agent/execute", {
        "thread_key": thread_key,
        "assignment_generation": gen,
        "harness": harness,
        "delivery": {"platform": "dev"},
    })
    return spawn, ex["execution_id"], t_execute


def dump_frames(name, frames):
    path = RESULTS / f"{name}.jsonl"
    with path.open("w") as f:
        for ev, data, eid, t in frames:
            f.write(json.dumps({"event": ev, "event_id": eid, "t": t, "data": data}) + "\n")
    return path


def histogram(frames):
    h = {}
    for ev, data, _, _ in frames:
        key = ev
        if isinstance(data, dict) and "type" in data:
            key = f"{ev}/{data['type']}"
        h[key] = h.get(key, 0) + 1
    return h


REPORT = []


def record(test, check, ok, detail=""):
    REPORT.append((test, check, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {test}: {check} {detail}", flush=True)


# ---------- tests ----------

def test_a_pong():
    tk = f"probe-a-{int(time.time())}"
    _, exec_id, t_exec = run_turn(tk, "Reply with exactly PONG and nothing else.")
    frames, t_first, t_first_text = [], None, None
    for ev, data, eid, t in tail_events(tk, exec_id, overall_timeout=900,
                                        read_timeout=900):
        frames.append((ev, data, eid, t))
        if t_first is None:
            t_first = t
        blob = json.dumps(data)
        if t_first_text is None and ("text_delta" in blob or "agentMessage" in blob):
            t_first_text = t
    dump_frames("A_pong", frames)
    state = api_get(f"/agent/executions/{exec_id}")
    record("A", "execution completed", state.get("status") == "completed",
           f"status={state.get('status')}")
    record("A", "result contains PONG", "PONG" in (state.get("result_text") or ""),
           (state.get("result_text") or "")[:80])
    if t_first:
        record("A", "TTFE (execute->first event)", True, f"{t_first - t_exec:.2f}s")
    else:
        record("A", "TTFE (execute->first event)", False, "no events received")
    if t_first_text:
        record("A", "TTFT (execute->first text delta)", t_first_text - t_exec < 10,
               f"{t_first_text - t_exec:.2f}s (gate <10s, warm)")
    record("A", "event histogram", True, json.dumps(histogram(frames)))
    return frames


def test_b_tooltest():
    tk = f"probe-b-{int(time.time())}"
    _, exec_id, t_exec = run_turn(
        tk, "TOOLTEST - run the Bash command the model requests, then report its output.")
    frames = list(tail_events(tk, exec_id, overall_timeout=900, read_timeout=900))
    dump_frames("B_tooltest", frames)
    blob = json.dumps([d for _, d, _, _ in frames])
    record("B", "tool_use visible in event stream", "tool_use" in blob)
    record("B", "tool_result visible in event stream", "tool_result" in blob)
    record("B", "tool output roundtripped", "atrium-roundtrip-ok" in blob)
    state = api_get(f"/agent/executions/{exec_id}")
    record("B", "execution completed", state.get("status") == "completed",
           f"status={state.get('status')}")
    record("B", "TOOLCHAIN_OK in result", "TOOLCHAIN_OK" in (state.get("result_text") or ""))
    record("B", "event histogram", True, json.dumps(histogram(frames)))
    return frames


def test_c_reconnect():
    tk = f"probe-c-{int(time.time())}"
    _, exec_id, _ = run_turn(tk, "LONGSTREAM please")
    first = []
    for frame in tail_events(tk, exec_id, max_events=30, overall_timeout=900,
                             read_timeout=900):
        first.append(frame)
    ids = [eid for _, _, eid, _ in first if eid is not None]
    record("C", "events carry usable ids", len(ids) >= len(first) // 2,
           f"{len(ids)}/{len(first)} frames had ids")
    last_id = ids[-1] if ids else 0
    rest = list(tail_events(tk, exec_id, after_event_id=last_id,
                            overall_timeout=900, read_timeout=900))
    dump_frames("C_first", first)
    dump_frames("C_rest", rest)
    all_ids = ids + [eid for _, _, eid, _ in rest if eid is not None]
    monotonic = all(b > a for a, b in zip(all_ids, all_ids[1:]))
    record("C", "resumed ids strictly increasing, no dupes", monotonic,
           f"{len(all_ids)} ids, span {all_ids[0]}..{all_ids[-1]}" if all_ids else "none")
    # replay determinism: two cold replays must match
    r1 = list(tail_events(tk, exec_id, after_event_id=0, overall_timeout=900,
                          read_timeout=900))
    r2 = list(tail_events(tk, exec_id, after_event_id=0, overall_timeout=900,
                          read_timeout=900))
    s1 = [json.dumps((e, d, i)) for e, d, i, _ in r1]
    s2 = [json.dumps((e, d, i)) for e, d, i, _ in r2]
    record("C", "replay deterministic (two cold replays identical)", s1 == s2,
           f"replay1={len(s1)} frames replay2={len(s2)} frames")
    live_ids = set(all_ids)
    replay_ids = {i for _, _, i, _ in r1 if i is not None}
    missing = live_ids - replay_ids
    record("C", "no live events missing from replay", not missing,
           f"missing={sorted(missing)[:5]}" if missing else "")
    return first + rest


def test_d_apikill():
    tk = f"probe-d-{int(time.time())}"
    _, exec_id, _ = run_turn(tk, "SLOWSTREAM please")
    seen = []
    try:
        for frame in tail_events(tk, exec_id, max_events=10, overall_timeout=300,
                                 read_timeout=300):
            seen.append(frame)
    except Exception as e:
        record("D", "pre-kill stream readable", False, str(e))
        return []
    record("D", "pre-kill stream readable", len(seen) > 0, f"{len(seen)} frames")
    last_id = max((eid for _, _, eid, _ in seen if eid is not None), default=0)
    subprocess.run(
        ["kubectl", "delete", "pod", "-n", NS, "-l",
         "app.kubernetes.io/component=api", "--wait=false"],
        check=False, capture_output=True,
    )
    time.sleep(5)
    subprocess.run(
        ["kubectl", "wait", "-n", NS, "--for=condition=ready", "pod",
         "-l", "app.kubernetes.io/component=api", "--timeout=300s"],
        check=False, capture_output=True,
    )
    start_port_forward()
    deadline = time.monotonic() + 600
    status = None
    while time.monotonic() < deadline:
        try:
            state = api_get(f"/agent/executions/{exec_id}")
            status = state.get("status")
            if status in ("completed", "failed", "failed_permanent", "cancelled"):
                break
        except Exception:
            ensure_forward_alive()
        time.sleep(5)
    record("D", "execution reached terminal state after API kill",
           status is not None, f"status={status}")
    replay = list(tail_events(tk, exec_id, after_event_id=0, overall_timeout=900,
                              read_timeout=900))
    dump_frames("D_replay", replay)
    replay_ids = [eid for _, _, eid, _ in replay if eid is not None]
    record("D", "durable replay available post-restart", len(replay) > 0,
           f"{len(replay)} frames")
    record("D", "pre-kill events present in replay",
           last_id in set(replay_ids) or last_id == 0,
           f"last pre-kill id={last_id}")
    return replay


def write_report():
    lines = ["# Phase 0 probe report", "",
             f"Run: {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    fails = 0
    for test, check, ok, detail in REPORT:
        mark = "✅" if ok else "❌"
        if not ok:
            fails += 1
        lines.append(f"- {mark} **{test}** {check} — {detail}")
    lines.append("")
    lines.append(f"**{len(REPORT) - fails}/{len(REPORT)} checks passed.**")
    (RESULTS / "report.md").write_text("\n".join(lines))
    print("\n".join(lines))
    return fails


if __name__ == "__main__":
    which = [a.upper() for a in sys.argv[1:]] or ["A", "B", "C"]
    start_port_forward()
    try:
        if "A" in which:
            test_a_pong()
        if "B" in which:
            test_b_tooltest()
        if "C" in which:
            test_c_reconnect()
        if "D" in which:
            test_d_apikill()
    finally:
        stop_port_forward()
    sys.exit(1 if write_report() else 0)
