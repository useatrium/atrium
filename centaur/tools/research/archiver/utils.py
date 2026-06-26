#!/usr/bin/env python3
"""Utility helpers for parchiver CLI."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, urlunparse


@dataclass
class FileRecord:
    source_url: str | None
    source_type: str
    file_path: str
    filename: str
    file_hash: str
    size_bytes: int
    mime_type: str | None
    title: str | None = None
    relative_path: str | None = None
    status: str = "ok"
    error: str | None = None


def compute_file_hash(path: Path) -> str:
    sha256 = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def detect_mime_type(path: Path) -> str | None:
    mime_type, _ = mimetypes.guess_type(path.name)
    return mime_type


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    # strip query/fragment for canonicalization
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def slugify(text: str, max_len: int = 64) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(slug) > max_len:
        slug = slug[:max_len].rstrip("-")
    return slug or "unknown"


def _json_encoder(obj):
    from datetime import date, datetime
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def dump_json(data: dict) -> str:
    return json.dumps(data, indent=2, sort_keys=True, default=_json_encoder)


def file_record_to_dict(record: FileRecord) -> dict:
    return asdict(record)
