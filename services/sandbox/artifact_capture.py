#!/usr/bin/env python3
"""Best-effort artifact capture loop for Centaur sandboxes."""

from __future__ import annotations

import fnmatch
import hashlib
import logging
import mimetypes
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

DEFAULT_DIRS = "/home/agent/workspace:/tmp:/home/agent/outputs:/var/tmp"
DEFAULT_CONTEXT_DIR = "/etc/centaur/runtime-context"
DEFAULT_MAX_BYTES = 1_048_576
DEFAULT_INTERVAL_S = 2.5
READ_CHUNK_BYTES = 1024 * 1024
SECRET_SCAN_BYTES = 64 * 1024

ALLOWED_EXTENSIONS = {
    ".csv",
    ".gif",
    ".htm",
    ".html",
    ".jpeg",
    ".jpg",
    ".json",
    ".md",
    ".mp3",
    ".mp4",
    ".pdf",
    ".png",
    ".svg",
    ".tsv",
    ".txt",
    ".wav",
    ".webp",
    ".xml",
    ".yaml",
    ".yml",
}
ALLOWED_MIME_PREFIXES = ("image/", "audio/", "video/")
ALLOWED_MIMES = {
    "application/json",
    "application/pdf",
    "application/xml",
    "text/csv",
    "text/html",
    "text/markdown",
    "text/plain",
    "text/tab-separated-values",
    "text/xml",
}
JUNK_EXTENSIONS = {
    ".a",
    ".class",
    ".dylib",
    ".map",
    ".node",
    ".o",
    ".obj",
    ".pyc",
    ".pyo",
    ".so",
    ".whl",
}
DENY_COMPONENTS = {
    ".cache",
    ".git",
    ".next",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "site-packages",
    "target",
    "venv",
}
SECRET_NAME_PATTERNS = (
    ".env",
    "*.key",
    "*.p8",
    "*.pem",
    ".netrc",
    "id_rsa",
)
SECRET_PATH_SUFFIXES = (".aws/credentials",)
SECRET_CONTENT_PATTERNS = (
    re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(rb"\bAWS_SECRET_ACCESS_KEY\s*="),
    re.compile(rb"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(rb"\bOPENAI_API_KEY\s*="),
    re.compile(rb"\bANTHROPIC_API_KEY\s*="),
    re.compile(rb"\bSLACK_BOT_TOKEN\s*="),
    re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    re.compile(rb"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
)


@dataclass(frozen=True)
class FileSnapshot:
    mtime_ns: int
    size: int


@dataclass(frozen=True)
class CaptureDecision:
    surface: bool
    stage_bytes: bool
    reason: str
    mime: str


@dataclass(frozen=True)
class CapturedArtifact:
    path: str
    kind: str
    mime: str
    size_bytes: int
    sha256: str
    data: bytes | None


class ArtifactCapture:
    def __init__(
        self,
        *,
        api_url: str,
        api_key: str,
        dirs: Iterable[str],
        max_bytes: int = DEFAULT_MAX_BYTES,
        context_dir: str = DEFAULT_CONTEXT_DIR,
        sender: Callable[[CapturedArtifact, str, str | None], None] | None = None,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.dirs = [Path(value) for value in dirs if value]
        self.max_bytes = max_bytes
        self.context_dir = Path(context_dir)
        self.sender = sender or self._send
        self.seen: dict[str, FileSnapshot] = {}
        self.sent_sha256: set[str] = set()
        self.sent_paths: set[str] = set()

    def scan_once(self) -> None:
        for path in walk_candidate_files(self.dirs):
            try:
                self._maybe_capture(path)
            except Exception:
                logging.exception("artifact capture failed for %s", path)

    def _maybe_capture(self, path: Path) -> None:
        stat = path.stat()
        if not path.is_file():
            return
        snapshot = FileSnapshot(mtime_ns=stat.st_mtime_ns, size=stat.st_size)
        key = str(path)
        if self.seen.get(key) == snapshot:
            return
        self.seen[key] = snapshot

        sample = read_sample(path)
        decision = classify_file(path, stat.st_size, sample, self.max_bytes)
        if not decision.surface:
            return

        digest, data = hash_and_maybe_read(path, decision.stage_bytes)
        if digest in self.sent_sha256:
            return
        # The sample scan only saw the first 64 KiB; re-scan the full staged
        # bytes so a secret deeper in the file can't be exfiltrated.
        if data is not None and any(
            pattern.search(data) for pattern in SECRET_CONTENT_PATTERNS
        ):
            logging.info("artifact capture skipping suspected secret in %s", path)
            return

        execution_id = self.execution_id()
        if not execution_id:
            logging.debug("artifact capture waiting for execution id")
            return
        thread_key = self.thread_key()
        kind = "modified" if key in self.sent_paths else "created"
        artifact = CapturedArtifact(
            path=key,
            kind=kind,
            mime=decision.mime,
            size_bytes=stat.st_size,
            sha256=digest,
            data=data,
        )
        try:
            self.sender(artifact, execution_id, thread_key)
        except Exception:
            self.seen.pop(key, None)
            raise
        self.sent_sha256.add(digest)
        self.sent_paths.add(key)

    def execution_id(self) -> str | None:
        return first_nonempty(
            os.environ.get("CENTAUR_EXECUTION_ID"),
            read_context_value(self.context_dir / "execution_id"),
        )

    def thread_key(self) -> str | None:
        return first_nonempty(
            os.environ.get("CENTAUR_THREAD_KEY"),
            read_context_value(self.context_dir / "thread_key"),
        )

    def _send(
        self,
        artifact: CapturedArtifact,
        execution_id: str,
        thread_key: str | None,
    ) -> None:
        import httpx

        fields: list[tuple[str, tuple[None, str] | tuple[str, bytes, str]]] = [
            ("path", (None, artifact.path)),
            ("kind", (None, artifact.kind)),
            ("mime", (None, artifact.mime)),
            ("size_bytes", (None, str(artifact.size_bytes))),
            ("sha256", (None, artifact.sha256)),
        ]
        if artifact.data is not None:
            fields.append(
                ("bytes", (Path(artifact.path).name, artifact.data, artifact.mime))
            )
        headers = {"x-api-key": self.api_key}
        if thread_key:
            headers["x-centaur-thread-key"] = thread_key
        with httpx.Client(timeout=10.0) as client:
            response = client.post(
                f"{self.api_url}/agent/executions/{execution_id}/artifacts",
                files=fields,
                headers=headers,
            )
            response.raise_for_status()


def walk_candidate_files(dirs: Iterable[Path]) -> Iterable[Path]:
    for root in dirs:
        if not root.exists():
            continue
        for current, dirnames, filenames in os.walk(root):
            current_path = Path(current)
            dirnames[:] = [
                dirname
                for dirname in dirnames
                if not path_denied(current_path / dirname)
                and not (current_path / dirname).is_symlink()
            ]
            if path_denied(current_path):
                continue
            for filename in filenames:
                path = current_path / filename
                # Never follow symlinks out of the allow-listed roots.
                if path.is_symlink():
                    continue
                if not path_denied(path):
                    yield path


def classify_file(
    path: Path, size: int, sample: bytes, max_bytes: int
) -> CaptureDecision:
    mime = guess_mime(path)
    if secret_denied(path, sample):
        return CaptureDecision(False, False, "secret", mime)
    if path_denied(path):
        return CaptureDecision(False, False, "path_denied", mime)
    if path.suffix.lower() in JUNK_EXTENSIONS:
        return CaptureDecision(False, False, "junk_extension", mime)
    if not artifact_type_allowed(path, mime):
        return CaptureDecision(False, False, "type_denied", mime)
    return CaptureDecision(True, size <= max_bytes, "artifact", mime)


def path_denied(path: Path) -> bool:
    normalized = path.as_posix().lower()
    parts = {part.lower() for part in path.parts}
    if parts & DENY_COMPONENTS:
        return True
    return fnmatch.fnmatch(path.name.lower(), "*.lock") or any(
        suffix in normalized for suffix in SECRET_PATH_SUFFIXES
    )


def secret_denied(path: Path, sample: bytes) -> bool:
    name = path.name.lower()
    if any(fnmatch.fnmatch(name, pattern) for pattern in SECRET_NAME_PATTERNS):
        return True
    normalized = path.as_posix().lower()
    if any(suffix in normalized for suffix in SECRET_PATH_SUFFIXES):
        return True
    return any(pattern.search(sample) for pattern in SECRET_CONTENT_PATTERNS)


def artifact_type_allowed(path: Path, mime: str) -> bool:
    suffix = path.suffix.lower()
    if suffix in ALLOWED_EXTENSIONS:
        return True
    if mime in ALLOWED_MIMES:
        return True
    return any(mime.startswith(prefix) for prefix in ALLOWED_MIME_PREFIXES)


def guess_mime(path: Path) -> str:
    mime, _encoding = mimetypes.guess_type(path.as_posix())
    return mime or "application/octet-stream"


def read_sample(path: Path) -> bytes:
    with path.open("rb") as handle:
        return handle.read(SECRET_SCAN_BYTES)


def hash_and_maybe_read(path: Path, include_data: bool) -> tuple[str, bytes | None]:
    digest = hashlib.sha256()
    chunks: list[bytes] = []
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(READ_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            if include_data:
                chunks.append(chunk)
    return digest.hexdigest(), b"".join(chunks) if include_data else None


def read_context_value(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def first_nonempty(*values: str | None) -> str | None:
    for value in values:
        if value and value.strip():
            return value.strip()
    return None


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        logging.warning("invalid %s; using %s", name, default)
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except ValueError:
        logging.warning("invalid %s; using %s", name, default)
        return default


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("ARTIFACT_CAPTURE_LOG_LEVEL", "INFO").upper(),
        format="artifact_capture %(levelname)s %(message)s",
    )
    if not env_bool("ARTIFACT_CAPTURE_ENABLED", True):
        return 0
    api_url = os.environ.get("CENTAUR_API_URL", "").strip()
    api_key = os.environ.get("ARTIFACT_CAPTURE_API_KEY", "").strip()
    if not api_url or not api_key:
        logging.info(
            "artifact capture disabled: missing CENTAUR_API_URL or ARTIFACT_CAPTURE_API_KEY"
        )
        return 0

    capture = ArtifactCapture(
        api_url=api_url,
        api_key=api_key,
        dirs=os.environ.get("ARTIFACT_CAPTURE_DIRS", DEFAULT_DIRS).split(":"),
        max_bytes=env_int("ARTIFACT_CAPTURE_MAX_BYTES", DEFAULT_MAX_BYTES),
        context_dir=os.environ.get("ARTIFACT_CAPTURE_CONTEXT_DIR", DEFAULT_CONTEXT_DIR),
    )
    interval = env_float("ARTIFACT_CAPTURE_INTERVAL_S", DEFAULT_INTERVAL_S)
    logging.info("artifact capture started")
    while True:
        try:
            capture.scan_once()
        except Exception:
            logging.exception("artifact capture scan failed")
        time.sleep(interval)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        logging.exception("artifact capture exited unexpectedly")
        sys.exit(0)
