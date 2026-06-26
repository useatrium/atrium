"""VictoriaMetrics HTTP API client for PromQL/MetricsQL queries."""

import os
from typing import Any

import httpx


class VictoriaMetricsClient:
    """Query VictoriaMetrics via PromQL/MetricsQL.

    Supports instant queries, range queries, label discovery, and metric listing.
    Connects directly to VictoriaMetrics (default: http://victoriametrics:8428).
    """

    def __init__(self, url: str | None = None, timeout: float = 30.0):
        self._url = url
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def base_url(self) -> str:
        url = (self._url or os.getenv("VICTORIAMETRICS_URL", "http://victoriametrics:8428")).rstrip("/")
        if url and not url.startswith(("http://", "https://")):
            url = f"http://{url}"
        return url

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(base_url=self.base_url, timeout=self.timeout)
        return self._client

    def query(self, expr: str, time: str | None = None) -> dict[str, Any]:
        """Run a PromQL/MetricsQL instant query.

        Args:
            expr: PromQL expression (e.g. 'sum(agent_execution_terminal_total)').
            time: Evaluation timestamp (RFC3339 or Unix). Defaults to now.
        """
        params: dict[str, str] = {"query": expr}
        if time:
            params["time"] = time
        resp = self.client.get("/api/v1/query", params=params)
        resp.raise_for_status()
        data = resp.json()
        return _format_result(data)

    def query_range(
        self,
        expr: str,
        start: str,
        end: str | None = None,
        step: str = "60s",
    ) -> dict[str, Any]:
        """Run a PromQL/MetricsQL range query.

        Args:
            expr: PromQL expression.
            start: Range start (RFC3339 or Unix timestamp).
            end: Range end. Defaults to now.
            step: Query step (e.g. '15s', '1m', '5m').
        """
        params: dict[str, str] = {"query": expr, "start": start, "step": step}
        if end:
            params["end"] = end
        resp = self.client.get("/api/v1/query_range", params=params)
        resp.raise_for_status()
        data = resp.json()
        return _format_result(data)

    def series(
        self,
        match: str,
        start: str | None = None,
        end: str | None = None,
    ) -> list[dict[str, str]]:
        """Find time series matching a label selector.

        Args:
            match: Series selector (e.g. '{__name__=~"agent_.*"}').
            start: Optional start time.
            end: Optional end time.
        """
        params: dict[str, str] = {"match[]": match}
        if start:
            params["start"] = start
        if end:
            params["end"] = end
        resp = self.client.get("/api/v1/series", params=params)
        resp.raise_for_status()
        return resp.json().get("data", [])

    def label_values(self, label: str) -> list[str]:
        """Get all values for a label (e.g. '__name__' for all metric names).

        Args:
            label: Label name.
        """
        resp = self.client.get(f"/api/v1/label/{label}/values")
        resp.raise_for_status()
        return resp.json().get("data", [])

    def metric_names(self, prefix: str = "agent_") -> list[str]:
        """List metric names, optionally filtered by prefix.

        Args:
            prefix: Only return metrics starting with this prefix (default: 'agent_').
        """
        all_names = self.label_values("__name__")
        if prefix:
            return [n for n in all_names if n.startswith(prefix)]
        return all_names

    def ready(self) -> bool:
        """Check if VictoriaMetrics is ready."""
        try:
            resp = self.client.get("/health")
            return resp.status_code == 200
        except Exception:
            return False

    def close(self):
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _format_result(data: dict[str, Any]) -> dict[str, Any]:
    """Flatten the Prometheus API response into a concise format."""
    status = data.get("status", "error")
    result_type = data.get("data", {}).get("resultType", "")
    results = data.get("data", {}).get("result", [])

    formatted: list[dict[str, Any]] = []
    for item in results:
        metric = item.get("metric", {})
        labels = {k: v for k, v in metric.items() if k != "__name__"}
        name = metric.get("__name__", "")
        entry: dict[str, Any] = {}
        if name:
            entry["metric"] = name
        if labels:
            entry["labels"] = labels
        if "value" in item:
            entry["value"] = item["value"][1]
        if "values" in item:
            entry["values"] = [[v[0], v[1]] for v in item["values"]]
        formatted.append(entry)

    return {
        "status": status,
        "type": result_type,
        "results": formatted,
    }


def _client() -> VictoriaMetricsClient:
    return VictoriaMetricsClient()
