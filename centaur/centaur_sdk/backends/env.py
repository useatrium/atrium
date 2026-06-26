"""Backend that reads secrets from ``os.environ``."""

from __future__ import annotations

import os

from centaur_sdk.backends.base import SecretBackend


class EnvBackend(SecretBackend):
    """Resolve secrets from environment variables."""

    async def get(self, key: str) -> str | None:
        return os.environ.get(key)

    async def list_keys(self) -> list[str]:
        return list(os.environ.keys())
