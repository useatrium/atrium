"""Pluggable secret backend system.

Public API:
    - ``get_backend()`` / ``configure()`` — access the active backend
    - ``SecretBackend`` — ABC for custom backends
    - ``StubBackend`` — server-mode default (returns key names as stubs)
    - ``EnvBackend`` — CLI-only (banned in server code; see pyproject.toml)
"""

from __future__ import annotations

from centaur_sdk.backends.base import SecretBackend
from centaur_sdk.backends.env import EnvBackend
from centaur_sdk.backends.registry import auto_configure, configure, get_backend
from centaur_sdk.backends.stub import StubBackend

__all__ = [
    "EnvBackend",
    "SecretBackend",
    "StubBackend",
    "auto_configure",
    "configure",
    "get_backend",
]
