"""Listen Notes API client."""

import subprocess

import httpx

from centaur_sdk import secret


class ListenNotesClient:
    """Client for Listen Notes API."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.base_url = "https://listen-api.listennotes.com/api/v2"
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _get_api_key(self) -> str | None:
        """Get API key from instance, env var, or 1Password."""
        if self._api_key:
            return self._api_key
        key = secret("LISTENNOTES_KEY", "")
        if key:
            return key
        try:
            result = subprocess.run(
                ["op", "read", "op://ai-agents/Listen Notes API Key/credential"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception:
            pass
        return None

    def _request(
        self,
        endpoint: str,
        params: dict | None = None,
    ) -> dict | list:
        """Make an API request."""
        api_key = self._get_api_key()
        if not api_key:
            raise RuntimeError("LISTENNOTES_KEY not set.")

        url = f"{self.base_url}{endpoint}"
        headers = {"X-ListenAPI-Key": api_key}

        try:
            response = self.client.get(url, params=params, headers=headers)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def search(
        self,
        query: str,
        type: str = "episode",
        offset: int = 0,
        len_min: int | None = None,
        len_max: int | None = None,
    ) -> dict:
        """Search for episodes or podcasts."""
        params = {"q": query, "type": type, "offset": offset}
        if len_min is not None:
            params["len_min"] = len_min
        if len_max is not None:
            params["len_max"] = len_max
        return self._request("/search", params=params)

    def get_podcast(self, podcast_id: str) -> dict:
        """Get podcast details."""
        return self._request(f"/podcasts/{podcast_id}")

    def get_episode(self, episode_id: str) -> dict:
        """Get episode details."""
        return self._request(f"/episodes/{episode_id}")

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> ListenNotesClient:
    return ListenNotesClient()
