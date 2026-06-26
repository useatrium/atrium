"""Demo tool for testing CD hot-reload."""

from datetime import datetime, timezone


class DemoClient:
    def ping(self) -> dict:
        """Return a pong with the current server time."""
        return {"pong": True, "server_time": datetime.now(timezone.utc).isoformat(), "version": 4}

    def echo(self, message: str) -> dict:
        """Echo back the given message."""
        return {"echo": message}


def _client() -> DemoClient:
    return DemoClient()
