"""Abstract base class for secret backends."""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod


class SecretBackend(ABC):
    """Interface that all secret backends must implement."""

    @abstractmethod
    async def get(self, key: str) -> str | None:
        """Retrieve a secret by key. Returns ``None`` if not found."""

    @abstractmethod
    async def list_keys(self) -> list[str]:
        """Return all available key names."""

    def get_sync(self, key: str) -> str | None:
        """Synchronous wrapper around :meth:`get`.

        Safe to call from non-async code. If an event loop is already running
        (e.g. inside FastAPI) this uses a background thread to avoid blocking.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.get(key))

        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, self.get(key)).result()
