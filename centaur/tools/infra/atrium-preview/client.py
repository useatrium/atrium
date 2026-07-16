"""HTTP client for the Atrium preview launcher."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

DEFAULT_LAUNCHER_URL = "https://atrium-preview-launcher.garybasin.com"


class PreviewError(Exception):
    """An error suitable for concise display to an agent."""


class LauncherHTTPError(PreviewError):
    """An unsuccessful response from the preview launcher."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"launcher returned HTTP {status_code}: {detail}")


def _single_line(value: str) -> str:
    return " ".join(value.split())


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return _single_line(response.text) or "empty response"

    if not isinstance(payload, dict):
        return _single_line(response.text) or "unexpected response"

    code = payload.get("error")
    message = payload.get("message")
    if code and message:
        return f"{_single_line(str(code))}: {_single_line(str(message))}"
    if message:
        return _single_line(str(message))
    if code:
        return _single_line(str(code))
    return _single_line(response.text) or "unexpected response"


def _preview_path(preview_id: str) -> str:
    return f"/previews/{quote(preview_id, safe='')}"


class AtriumPreviewClient:
    """Client for creating and managing Atrium branch previews."""

    def __init__(
        self,
        base_url: str = DEFAULT_LAUNCHER_URL,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.transport = transport
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                base_url=self.base_url,
                timeout=self.timeout,
                transport=self.transport,
                headers={"Accept": "application/json"},
            )
        return self._client

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            response = self.client.request(method, path, json=body)
        except httpx.TimeoutException as exc:
            raise PreviewError("launcher request timed out") from exc
        except httpx.RequestError as exc:
            raise PreviewError(f"launcher request failed: {_single_line(str(exc))}") from exc

        if not response.is_success:
            raise LauncherHTTPError(response.status_code, _error_detail(response))

        if not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError as exc:
            raise PreviewError("launcher returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise PreviewError("launcher returned an unexpected JSON value")
        return payload

    def create(self, repo: str, ref: str) -> dict[str, Any]:
        return self._request("POST", "/previews", {"repo": repo, "ref": ref})

    def status(self, preview_id: str) -> dict[str, Any]:
        return self._request("GET", _preview_path(preview_id))

    def list(self) -> dict[str, Any]:
        return self._request("GET", "/previews")

    def destroy(self, preview_id: str) -> dict[str, Any]:
        return self._request("DELETE", _preview_path(preview_id))

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> AtriumPreviewClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def _client() -> AtriumPreviewClient:
    return AtriumPreviewClient()
