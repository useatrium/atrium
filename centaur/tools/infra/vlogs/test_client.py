from __future__ import annotations

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("vlogs_client", Path(__file__).with_name("client.py"))
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
VictoriaLogsClient = module.VictoriaLogsClient


class StubVictoriaLogsClient(VictoriaLogsClient):
    def __init__(self):
        super().__init__(url="http://victorialogs.test")
        self.hit_calls: list[dict[str, str | None]] = []

    def field_values(
        self,
        field: str,
        query: str = "*",
        limit: int = 100,
        start: str | None = None,
        end: str | None = None,
    ) -> list[str]:
        assert field == "service"
        return ["api", "", "slackbot"]

    def hits(
        self,
        query: str,
        start: str | None = None,
        end: str | None = None,
        step: str | None = None,
    ) -> dict:
        self.hit_calls.append({"query": query, "start": start, "step": step})
        if "level:error" in query:
            return {"hits": [{"fields": {}, "values": [1, 1], "total": 2}]}
        return {"hits": [{"fields": {}, "values": [5, 6], "total": 11}]}


def test_service_health_uses_explicit_step_and_skips_blank_services() -> None:
    client = StubVictoriaLogsClient()

    result = client.service_health(start="6h")

    assert result == {
        "api": {"total_count": 11, "error_count": 2},
        "slackbot": {"total_count": 11, "error_count": 2},
    }
    assert client.hit_calls
    assert all(call["start"] == "6h" for call in client.hit_calls)
    assert all(call["step"] == "5m" for call in client.hit_calls)


def test_slow_requests_sorts_decimal_duration_ms() -> None:
    client = VictoriaLogsClient(url="http://victorialogs.test")
    client.query = lambda *args, **kwargs: [  # type: ignore[method-assign]
        {"path": "/slow", "duration_ms": "11372.17"},
        {"path": "/fast", "duration_ms": "95"},
        {"path": "/bad", "duration_ms": "n/a"},
    ]

    result = client.slow_requests(start="24h")

    assert [entry["path"] for entry in result] == ["/slow", "/fast", "/bad"]
