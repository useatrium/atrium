"""Backend that returns key names as stub values for firewall injection.

In server mode, tools never see real secrets. They receive the key name
itself (e.g. ``secret("ALCHEMY_API_KEY")`` → ``"ALCHEMY_API_KEY"``).
The outbound HTTPS request carries this stub in a header, and the
firewall (mitmproxy) replaces it with the real secret before it leaves
the network.
"""

from __future__ import annotations

import os

from centaur_sdk.backends.base import SecretBackend


class StubBackend(SecretBackend):
    """Return the key name itself as the value.

    This is the server-mode default. Tools put the stub in HTTP headers,
    and the firewall replaces it with the real credential in-flight.

    Some secrets can't go through firewall injection: things like a
    Postgres DSN are consumed in-process rather than placed in an
    outbound HTTPS header, so a stub is unusable. When the key is
    present in the environment, its value is returned instead.
    """

    async def get(self, key: str) -> str | None:
        env_val = os.environ.get(key)
        if env_val is not None:
            return env_val
        return key

    async def list_keys(self) -> list[str]:
        return []
