"""ethPandaOps API client for execution payload timings."""

from collections import defaultdict

import httpx

BASE_URL = "https://lab.ethpandaops.io/api/v1"
DEFAULT_NETWORK = "mainnet"


class RethClient:
    """Client for ethPandaOps execution payload timing data."""

    def __init__(self, network: str = DEFAULT_NETWORK):
        self.network = network

    @staticmethod
    def parse_duration(duration: str) -> int:
        """Parse duration string like '1h', '6hr', '24hr', '1d' to seconds."""
        duration = duration.lower().strip()

        if duration.endswith("hr"):
            return int(duration[:-2]) * 3600
        elif duration.endswith("h"):
            return int(duration[:-1]) * 3600
        elif duration.endswith("d"):
            return int(duration[:-1]) * 86400
        elif duration.endswith("m"):
            return int(duration[:-1]) * 60
        else:
            return int(duration) * 3600

    def get_execution_timings(
        self,
        hours: int = 1,
        page_size: int = 500,
    ) -> list[dict]:
        """Fetch execution payload timings from ethPandaOps."""
        import time

        since = int(time.time()) - (hours * 3600)
        url = f"{BASE_URL}/{self.network}/int_engine_new_payload"
        params = {
            "slot_start_date_time_gte": since,
            "page_size": page_size,
            "order_by": "slot desc",
        }

        with httpx.Client(timeout=30) as client:
            resp = client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        return data.get("int_engine_new_payload", [])

    @staticmethod
    def aggregate_timings(payloads: list[dict]) -> list[dict]:
        """Aggregate payload timings by client."""
        by_client: dict[str, list[int]] = defaultdict(list)
        versions: dict[str, str] = {}

        for p in payloads:
            client = p.get("meta_execution_implementation", "unknown")
            duration = p.get("duration_ms", 0)
            version = p.get("meta_execution_version", "")

            by_client[client].append(duration)
            if client not in versions or len(version) > len(versions[client]):
                versions[client] = version

        results = []
        for client, durations in by_client.items():
            sorted_durations = sorted(durations)
            n = len(sorted_durations)

            results.append(
                {
                    "client": client,
                    "version": versions.get(client, ""),
                    "count": n,
                    "avg_ms": sum(durations) // n if n else 0,
                    "min_ms": min(durations) if durations else 0,
                    "max_ms": max(durations) if durations else 0,
                    "p50_ms": sorted_durations[n // 2] if n else 0,
                    "p90_ms": sorted_durations[int(n * 0.9)] if n else 0,
                    "p99_ms": sorted_durations[int(n * 0.99)] if n else 0,
                }
            )

        results.sort(key=lambda x: x["avg_ms"])
        return results


def _client() -> RethClient:
    return RethClient()
