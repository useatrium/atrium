"""Firefox Profiler client - fetch and parse profiles via HTTP."""

import gzip
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024
MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024

ALLOWED_HOSTS = frozenset(
    {
        "share.firefox.dev",
        "profiler.firefox.com",
        "storage.googleapis.com",
    }
)


@dataclass
class ProfileMeta:
    """Profile metadata."""

    interval: float
    start_time: float
    product: str
    platform: str | None = None
    version: int = 0


@dataclass
class ThreadInfo:
    """Summary info for a thread."""

    tid: str | int
    name: str
    pid: str
    process_name: str
    is_main_thread: bool
    sample_count: int
    marker_count: int
    start_time_ms: float
    end_time_ms: float
    cpu_delta_total_ns: int | None = None


def _get_hostname(url: str) -> str:
    """Extract hostname from URL."""
    return urlparse(url).hostname or ""


class ProfilerClient:
    """Client for fetching Firefox Profiler profiles via HTTP."""

    STORAGE_BASE = "https://storage.googleapis.com/profile-store"
    PROFILER_BASE = "https://profiler.firefox.com"

    def __init__(
        self,
        timeout: float = 60.0,
        max_download_bytes: int = MAX_DOWNLOAD_BYTES,
        max_decompressed_bytes: int = MAX_DECOMPRESSED_BYTES,
    ):
        self.timeout = timeout
        self.max_download_bytes = max_download_bytes
        self.max_decompressed_bytes = max_decompressed_bytes
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                timeout=self.timeout,
                follow_redirects=True,
                headers={"User-Agent": "profslice/0.1.0"},
            )
        return self._client

    def _validate_host(self, url: str) -> None:
        """Validate that the URL host is allowed."""
        host = _get_hostname(url)
        if host not in ALLOWED_HOSTS:
            raise ValueError(
                f"Host '{host}' not allowed. Expected one of: {', '.join(ALLOWED_HOSTS)}"
            )

    def resolve_url(self, url: str) -> str:
        """Resolve a Firefox Profiler URL to a direct download URL."""
        self._validate_host(url)

        host = _get_hostname(url)

        if host == "share.firefox.dev":
            response = self.client.get(url)
            url = str(response.url)
            host = _get_hostname(url)
            self._validate_host(url)

        if host == "profiler.firefox.com":
            match = re.search(r"/public/([^/?#]+)", url)
            if match:
                token = match.group(1)
                return f"{self.STORAGE_BASE}/{token}"
            raise ValueError(f"Could not extract profile token from URL: {url}")

        if host == "storage.googleapis.com":
            parsed = urlparse(url)
            if not parsed.path.startswith("/profile-store/"):
                raise ValueError(f"Storage URL must use /profile-store/ path: {url}")
            return url

        raise ValueError(f"Could not resolve profile URL: {url}")

    def fetch_profile(self, url_or_path: str) -> dict[str, Any]:
        """Fetch and decompress a profile from URL or local path."""
        parsed = urlparse(url_or_path)
        is_url = parsed.scheme in ("http", "https")

        if not is_url:
            path = Path(url_or_path).expanduser()
            return self._load_local(str(path))

        download_url = self.resolve_url(url_or_path)
        content = self._download_with_limit(download_url)

        if content[:2] == b"\x1f\x8b":
            content = self._decompress_with_limit(content)

        return json.loads(content)

    def _download_with_limit(self, url: str) -> bytes:
        """Download URL content with size limit."""
        response = self.client.get(url)
        response.raise_for_status()

        content_length = response.headers.get("content-length")
        if content_length and int(content_length) > self.max_download_bytes:
            raise ValueError(
                f"Profile too large: {int(content_length)} bytes "
                f"(max: {self.max_download_bytes} bytes)"
            )

        content = response.content
        if len(content) > self.max_download_bytes:
            raise ValueError(
                f"Downloaded content too large: {len(content)} bytes "
                f"(max: {self.max_download_bytes} bytes)"
            )

        return content

    def _decompress_with_limit(self, data: bytes) -> bytes:
        """Decompress gzip data with size limit."""
        decompressed = gzip.decompress(data)
        if len(decompressed) > self.max_decompressed_bytes:
            raise ValueError(
                f"Decompressed content too large: {len(decompressed)} bytes "
                f"(max: {self.max_decompressed_bytes} bytes)"
            )
        return decompressed

    def _load_local(self, path: str) -> dict[str, Any]:
        """Load a local profile file."""
        if path.endswith(".gz"):
            with gzip.open(path, "rt", encoding="utf-8") as f:
                return json.load(f)
        else:
            with open(path, encoding="utf-8") as f:
                return json.load(f)

    def save_profile(self, profile: dict[str, Any], path: str) -> None:
        """Save a profile to a local file."""
        content = json.dumps(profile, separators=(",", ":"))

        if path.endswith(".gz"):
            with gzip.open(path, "wt", encoding="utf-8") as f:
                f.write(content)
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)

    def close(self):
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> ProfilerClient:
    return ProfilerClient()
