"""Deterministic mock of the Anthropic Messages API for Centaur seam validation.

The real claude-code harness in the Centaur sandbox points here via
ANTHROPIC_BASE_URL. Behavior is keyed off the last user message so probe
scripts can script scenarios:

  - text contains TOOLTEST   -> one Bash tool_use turn, then (after the
                                 harness posts tool_result) a final text turn
  - text contains LONGSTREAM -> 200 text deltas (pane/replay stress)
  - text contains SLOWSTREAM -> 90 deltas at 1s each (restart/durability window)
  - text contains PONG       -> replies exactly "PONG"
  - otherwise                -> echoes the text back, chunked

Stdlib only. Implements SSE streaming per the Anthropic Messages API spec
(message_start / content_block_* / message_delta / message_stop, plus ping).
"""

import json
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8081
DELTA_SLEEP = 0.012  # seconds between streamed deltas

_counter_lock = threading.Lock()
_counter = 0


def next_id(prefix: str) -> str:
    global _counter
    with _counter_lock:
        _counter += 1
        return f"{prefix}_mock{_counter:06d}"


def block_text(content) -> str:
    """Extract text from a message content field (string or block list)."""
    if isinstance(content, str):
        return content
    out = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text", ""))
    return "\n".join(out)


def analyze(body: dict):
    """Return (mode, detail) for this request."""
    messages = body.get("messages") or []
    tools = body.get("tools") or []
    has_bash = any(isinstance(t, dict) and t.get("name") == "Bash" for t in tools)

    last_tool_result = None
    for m in messages:
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    last_tool_result = b

    last_user_text = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            t = block_text(m.get("content"))
            if t.strip():
                last_user_text = t
                break

    if last_tool_result is not None:
        rc = last_tool_result.get("content")
        rtext = block_text(rc) if not isinstance(rc, str) else rc
        return ("final_after_tool", (rtext or "")[:160])
    if "TOOLTEST" in last_user_text and has_bash:
        return ("tool_use", None)
    if "LONGSTREAM" in last_user_text:
        return ("longstream", None)
    if "SLOWSTREAM" in last_user_text:
        return ("slowstream", None)
    if "PONG" in last_user_text:
        return ("pong", None)
    return ("echo", last_user_text[:200] or "(empty)")


def plan_response(mode, detail):
    """Return (text_chunks, tool_call, stop_reason, delta_sleep)."""
    if mode == "tool_use":
        cmd = "echo atrium-roundtrip-ok && uname -m && pwd"
        return ([], {"name": "Bash", "input": {"command": cmd}}, "tool_use", DELTA_SLEEP)
    if mode == "final_after_tool":
        return ([f"TOOLCHAIN_OK: {detail}"], None, "end_turn", DELTA_SLEEP)
    if mode == "longstream":
        return ([f"token-{i:04d} " for i in range(200)], None, "end_turn", DELTA_SLEEP)
    if mode == "slowstream":
        return ([f"slow-{i:03d} " for i in range(90)], None, "end_turn", 1.0)
    if mode == "pong":
        return (["PONG"], None, "end_turn", DELTA_SLEEP)
    text = f"ECHO: {detail}"
    n = max(1, len(text) // 5)
    chunks = [text[i : i + n] for i in range(0, len(text), n)]
    return (chunks, None, "end_turn", DELTA_SLEEP)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter, structured-ish
        print(json.dumps({"ts": time.time(), "msg": fmt % args}), flush=True)

    def _json(self, code, obj):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("request-id", next_id("req"))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._json(200, {"ok": True, "mock": "atrium-llm-mock"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            body = {}

        if self.path.rstrip("/").endswith("/count_tokens"):
            self._json(200, {"input_tokens": 42})
            return
        if "/v1/messages" not in self.path:
            self._json(200, {"ok": True})
            return

        mode, detail = analyze(body)
        chunks, tool_call, stop_reason, delta_sleep = plan_response(mode, detail)
        model = body.get("model", "claude-mock")
        msg_id = next_id("msg")

        if not body.get("stream"):
            content = []
            if chunks:
                content.append({"type": "text", "text": "".join(chunks)})
            if tool_call:
                content.append(
                    {
                        "type": "tool_use",
                        "id": next_id("toolu"),
                        "name": tool_call["name"],
                        "input": tool_call["input"],
                    }
                )
            self._json(
                200,
                {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": content,
                    "stop_reason": stop_reason,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 42, "output_tokens": 7},
                },
            )
            return

        # --- SSE streaming path ---
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("request-id", next_id("req"))
        # No Content-Length: stream until close. http.server handles this if
        # we don't promise keep-alive framing — so force close at the end.
        self.end_headers()

        def emit(event, data):
            frame = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
            self.wfile.write(frame)
            self.wfile.flush()

        emit(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 42, "output_tokens": 1},
                },
            },
        )
        emit("ping", {"type": "ping"})

        index = 0
        out_tokens = 0
        if chunks:
            emit(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {"type": "text", "text": ""},
                },
            )
            for ch in chunks:
                emit(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {"type": "text_delta", "text": ch},
                    },
                )
                out_tokens += 1
                time.sleep(delta_sleep)
            emit("content_block_stop", {"type": "content_block_stop", "index": index})
            index += 1

        if tool_call:
            tool_id = next_id("toolu")
            emit(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {
                        "type": "tool_use",
                        "id": tool_id,
                        "name": tool_call["name"],
                        "input": {},
                    },
                },
            )
            full = json.dumps(tool_call["input"])
            half = len(full) // 2
            for part in (full[:half], full[half:]):
                emit(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {"type": "input_json_delta", "partial_json": part},
                    },
                )
                time.sleep(DELTA_SLEEP)
            emit("content_block_stop", {"type": "content_block_stop", "index": index})
            index += 1

        emit(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                "usage": {"output_tokens": max(out_tokens, 1)},
            },
        )
        emit("message_stop", {"type": "message_stop"})
        self.close_connection = True


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(json.dumps({"msg": f"atrium-llm-mock listening on :{PORT}"}), flush=True)
    server.serve_forever()
