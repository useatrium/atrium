#!/usr/bin/env python3
"""
Google Drive/Docs/Slides/Sheets download adapters for parchiver.

This module provides the core download functionality for Google content.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

# Export formats by Google doc type
EXPORT_FORMATS = {
    "document": "pdf",
    "presentation": "pptx",
    "spreadsheets": "xlsx",
}

# Base URLs for direct export (works for publicly shared docs)
_EXPORT_URL_TEMPLATES = {
    "document": "https://docs.google.com/document/d/{file_id}/export?format={fmt}",
    "presentation": "https://docs.google.com/presentation/d/{file_id}/export/{fmt}",
    "spreadsheets": "https://docs.google.com/spreadsheets/d/{file_id}/export?format={fmt}",
}


@dataclass
class DownloadResult:
    """Result of a download attempt."""

    file_id: str
    link_type: str
    status: Literal["ok", "forbidden", "not_found", "error", "skipped"]
    output_path: str | None = None
    title: str | None = None
    error: str | None = None


def parse_google_url(url: str) -> tuple[str, str] | None:
    """
    Parse a Google URL and return (file_id, link_type).

    Returns None if not a recognized Google URL.
    """
    # Google Docs/Slides/Sheets: docs.google.com/{document,presentation,spreadsheets}/d/<id>
    match = re.search(
        r"docs\.google\.com/(document|presentation|spreadsheets)/d/([a-zA-Z0-9_-]+)",
        url,
    )
    if match:
        return match.group(2), match.group(1)

    # Google Drive folder: drive.google.com/drive/folders/<id>
    match = re.search(
        r"drive\.google\.com/drive/(?:u/\d+/)?folders/([a-zA-Z0-9_-]+)",
        url,
    )
    if match:
        return match.group(1), "folder"

    # Google Drive file: drive.google.com/file/d/<id>
    match = re.search(
        r"drive\.google\.com/file/d/([a-zA-Z0-9_-]+)",
        url,
    )
    if match:
        return match.group(1), "file"

    # Google Drive open?id=<id>
    match = re.search(
        r"drive\.google\.com/open\?id=([a-zA-Z0-9_-]+)",
        url,
    )
    if match:
        return match.group(1), "file"

    return None


def _gog_is_authed(account: str) -> bool:
    """Check whether gog has stored auth tokens for the given account."""
    try:
        result = subprocess.run(
            ["gog", "auth", "list", "--plain"],
            capture_output=True, text=True, timeout=10,
        )
        return account in result.stdout
    except Exception:
        return False


def run_gog(args: list[str], account: str) -> tuple[bool, str, str]:
    """Run a gog command. Returns (success, stdout, stderr)."""
    cmd = ["gog"] + args + ["--account", account]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        ok = result.returncode == 0
        return ok, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return False, "", "Command timed out"
    except Exception as e:
        return False, "", str(e)


def _direct_export_doc(
    file_id: str,
    link_type: str,
    output_dir: Path,
    known_title: str | None = None,
) -> DownloadResult:
    """Export a Google Doc/Slides/Sheets via direct HTTP (works for public docs)."""
    export_format = EXPORT_FORMATS.get(link_type, "pdf")
    url_template = _EXPORT_URL_TEMPLATES.get(link_type)
    if not url_template:
        return DownloadResult(
            file_id=file_id, link_type=link_type, status="error",
            error=f"No direct export URL for type: {link_type}",
        )

    url = url_template.format(file_id=file_id, fmt=export_format)
    try:
        resp = httpx.get(url, timeout=60, follow_redirects=True)
    except Exception as e:
        return DownloadResult(
            file_id=file_id, link_type=link_type, status="error",
            error=f"HTTP export request failed: {e}",
        )

    if resp.status_code == 200:
        content_type = resp.headers.get("content-type", "")
        # Google returns HTML when auth is required or doc doesn't exist
        if "text/html" in content_type:
            return DownloadResult(
                file_id=file_id, link_type=link_type, status="forbidden",
                title=known_title,
                error="Document requires authentication (not publicly shared)",
            )

        title = known_title or "untitled"
        slug = slugify(title)
        filename = f"{slug}__{file_id[:10]}.{export_format}"
        output_path = output_dir / filename
        output_path.write_bytes(resp.content)
        return DownloadResult(
            file_id=file_id, link_type=link_type, status="ok",
            output_path=str(output_path), title=title,
        )
    elif resp.status_code in (401, 403):
        return DownloadResult(
            file_id=file_id, link_type=link_type, status="forbidden",
            title=known_title,
            error=f"Access denied (HTTP {resp.status_code})",
        )
    elif resp.status_code == 404:
        return DownloadResult(
            file_id=file_id, link_type=link_type, status="not_found",
            title=known_title,
            error="Document not found (HTTP 404)",
        )
    else:
        return DownloadResult(
            file_id=file_id, link_type=link_type, status="error",
            title=known_title,
            error=f"HTTP export failed with status {resp.status_code}",
        )


def _direct_drive_file(
    file_id: str,
    output_dir: Path,
    known_name: str | None = None,
) -> DownloadResult:
    """Download a Google Drive file via direct HTTP (works for public files)."""
    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    try:
        resp = httpx.get(url, timeout=120, follow_redirects=True)
    except Exception as e:
        return DownloadResult(
            file_id=file_id, link_type="file", status="error",
            error=f"HTTP download failed: {e}",
        )

    if resp.status_code == 200:
        content_type = resp.headers.get("content-type", "")
        if "text/html" in content_type:
            return DownloadResult(
                file_id=file_id, link_type="file", status="forbidden",
                error="File requires authentication (not publicly shared)",
            )

        name = known_name or "unknown"
        safe_name = re.sub(r'[<>:"/\\|?*]', "_", name)
        stem = Path(safe_name).stem
        ext = Path(safe_name).suffix or ""
        filename = f"{stem}__{file_id[:8]}{ext}"
        output_path = output_dir / filename
        output_path.write_bytes(resp.content)
        return DownloadResult(
            file_id=file_id, link_type="file", status="ok",
            output_path=str(output_path), title=name,
        )
    elif resp.status_code in (401, 403):
        return DownloadResult(
            file_id=file_id, link_type="file", status="forbidden",
            error=f"Access denied (HTTP {resp.status_code})",
        )
    elif resp.status_code == 404:
        return DownloadResult(
            file_id=file_id, link_type="file", status="not_found",
            error="File not found (HTTP 404)",
        )
    else:
        return DownloadResult(
            file_id=file_id, link_type="file", status="error",
            error=f"HTTP download failed with status {resp.status_code}",
        )


def get_file_info(file_id: str, link_type: str, account: str) -> dict | None:
    """Get file metadata from Google."""
    if link_type == "document":
        success, stdout, stderr = run_gog(["docs", "info", file_id, "--json"], account)
    elif link_type == "presentation":
        success, stdout, stderr = run_gog(["slides", "info", file_id, "--json"], account)
    elif link_type == "spreadsheets":
        success, stdout, stderr = run_gog(["sheets", "metadata", file_id, "--json"], account)
    elif link_type == "folder":
        success, stdout, stderr = run_gog(["drive", "get", file_id, "--json"], account)
    else:
        success, stdout, stderr = run_gog(["drive", "get", file_id, "--json"], account)

    if success and stdout.strip():
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            pass
    return None


def slugify(text: str, max_len: int = 60) -> str:
    """Convert text to a filesystem-safe slug."""
    # Lowercase, replace non-alphanumeric with dashes
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower())
    # Remove leading/trailing dashes
    slug = slug.strip("-")
    # Truncate
    if len(slug) > max_len:
        slug = slug[:max_len].rstrip("-")
    return slug or "untitled"


def download_doc(
    file_id: str,
    link_type: str,
    output_dir: Path,
    account: str,
    known_title: str | None = None,
) -> DownloadResult:
    """Download a Google Doc/Slides/Sheets file."""
    # Check if gog has auth — if not, fall back to direct HTTP export
    if not _gog_is_authed(account):
        return _direct_export_doc(file_id, link_type, output_dir, known_title)

    # Get file info first
    info = get_file_info(file_id, link_type, account)

    if info is None:
        # Try direct HTTP fallback before giving up
        return _direct_export_doc(file_id, link_type, output_dir, known_title)

    # Extract title
    title = None
    if link_type == "document":
        title = info.get("document", {}).get("title") or info.get("file", {}).get("name")
    elif link_type == "presentation":
        title = info.get("file", {}).get("name")
    elif link_type == "spreadsheets":
        title = info.get("title")

    title = title or known_title or "untitled"

    # Determine export format and command
    export_format = EXPORT_FORMATS.get(link_type, "pdf")
    slug = slugify(title)
    filename = f"{slug}__{file_id[:10]}.{export_format}"
    output_path = output_dir / filename

    # Run export command
    if link_type == "document":
        cmd = ["docs", "export", file_id, "--format", export_format, "--output", str(output_path)]
    elif link_type == "presentation":
        cmd = ["slides", "export", file_id, "--format", export_format, "--output", str(output_path)]
    elif link_type == "spreadsheets":
        cmd = ["sheets", "export", file_id, "--format", export_format, "--output", str(output_path)]
    else:
        return DownloadResult(
            file_id=file_id,
            link_type=link_type,
            status="error",
            error=f"Unknown link type: {link_type}",
        )

    success, _stdout, stderr = run_gog(cmd, account)

    if success and output_path.exists():
        return DownloadResult(
            file_id=file_id,
            link_type=link_type,
            status="ok",
            output_path=str(output_path),
            title=title,
        )
    else:
        # Parse error type
        status: Literal["ok", "forbidden", "not_found", "error", "skipped"] = "error"
        if "403" in stderr or "forbidden" in stderr.lower() or "permission" in stderr.lower():
            status = "forbidden"
        elif "404" in stderr or "not found" in stderr.lower():
            status = "not_found"
        return DownloadResult(
            file_id=file_id,
            link_type=link_type,
            status=status,
            title=title,
            error=stderr.strip() or "Unknown error",
        )


def download_drive_file(
    file_id: str,
    output_dir: Path,
    account: str,
    known_name: str | None = None,
) -> DownloadResult:
    """Download a file from Google Drive."""
    # Check if gog has auth — if not, fall back to direct HTTP
    if not _gog_is_authed(account):
        return _direct_drive_file(file_id, output_dir, known_name)

    # Get file info
    success, stdout, stderr = run_gog(["drive", "get", file_id, "--json"], account)

    if not success:
        # Try direct HTTP fallback
        direct_result = _direct_drive_file(file_id, output_dir, known_name)
        if direct_result.status == "ok":
            return direct_result
        # Return original gog error if direct also failed
        status: Literal["ok", "forbidden", "not_found", "error", "skipped"] = (
            "not_found" if "404" in stderr else "error"
        )
        return DownloadResult(
            file_id=file_id,
            link_type="file",
            status=status,
            error=stderr.strip(),
        )

    try:
        info = json.loads(stdout)
    except json.JSONDecodeError:
        return DownloadResult(
            file_id=file_id,
            link_type="file",
            status="error",
            error="Failed to parse file info",
        )

    name = info.get("name") or known_name or "unknown"
    mime_type = info.get("mimeType", "")

    # Check if it's a Google native format - need to export
    if mime_type == "application/vnd.google-apps.document":
        return download_doc(file_id, "document", output_dir, account, known_title=name)
    elif mime_type == "application/vnd.google-apps.presentation":
        return download_doc(file_id, "presentation", output_dir, account, known_title=name)
    elif mime_type == "application/vnd.google-apps.spreadsheet":
        return download_doc(file_id, "spreadsheets", output_dir, account, known_title=name)

    # Regular file - download directly, preserve original filename
    safe_name = re.sub(r'[<>:"/\\|?*]', "_", name)  # Remove invalid chars
    stem = Path(safe_name).stem
    ext = Path(safe_name).suffix or ""
    filename = f"{stem}__{file_id[:8]}{ext}"
    output_path = output_dir / filename

    success, _stdout, stderr = run_gog(
        ["drive", "download", file_id, "--output", str(output_path)],
        account,
    )

    if success and output_path.exists():
        return DownloadResult(
            file_id=file_id,
            link_type="file",
            status="ok",
            output_path=str(output_path),
            title=name,
        )
    else:
        return DownloadResult(
            file_id=file_id,
            link_type="file",
            status="error",
            error=stderr.strip() or "Download failed",
        )


def _direct_drive_folder(
    folder_id: str,
    output_dir: Path,
) -> list[DownloadResult]:
    """Attempt to list + download a public Google Drive folder via HTTP.

    Google Drive does not expose a public folder listing API without auth.
    We return an informative error so callers know auth is needed.
    """
    return [
        DownloadResult(
            file_id=folder_id,
            link_type="folder",
            status="error",
            error="Google Drive folder listing requires gog authentication. "
                  "Run: gog auth add <email> --services drive,docs,sheets",
        )
    ]


def download_folder(
    folder_id: str,
    output_dir: Path,
    account: str,
    depth: int = 0,
    max_depth: int = 3,
    parent_path: str = "",
) -> list[DownloadResult]:
    """Recursively download a Google Drive folder."""
    results: list[DownloadResult] = []

    if depth > max_depth:
        return results

    # Check gog auth for folder listing (no HTTP fallback available)
    if not _gog_is_authed(account):
        return _direct_drive_folder(folder_id, output_dir)

    # List folder contents
    success, stdout, stderr = run_gog(
        ["drive", "ls", "--parent", folder_id, "--json"],
        account,
    )

    if not success:
        results.append(
            DownloadResult(
                file_id=folder_id,
                link_type="folder",
                status="error",
                error=stderr.strip() or "Failed to list folder",
            )
        )
        return results

    try:
        data = json.loads(stdout)
        files = data.get("files", [])
    except json.JSONDecodeError:
        results.append(
            DownloadResult(
                file_id=folder_id,
                link_type="folder",
                status="error",
                error="Failed to parse folder listing",
            )
        )
        return results

    for item in files:
        item_id = item.get("id", "")
        item_name = item.get("name", "unknown")
        mime_type = item.get("mimeType", "")

        if mime_type == "application/vnd.google-apps.folder":
            subfolder_dir = output_dir / slugify(item_name)
            subfolder_dir.mkdir(parents=True, exist_ok=True)
            sub_path = f"{parent_path}/{item_name}" if parent_path else item_name
            sub_results = download_folder(
                item_id,
                subfolder_dir,
                account,
                depth=depth + 1,
                max_depth=max_depth,
                parent_path=sub_path,
            )
            results.extend(sub_results)

        elif mime_type == "application/vnd.google-apps.document":
            results.append(
                download_doc(item_id, "document", output_dir, account, known_title=item_name)
            )

        elif mime_type == "application/vnd.google-apps.presentation":
            results.append(
                download_doc(item_id, "presentation", output_dir, account, known_title=item_name)
            )

        elif mime_type == "application/vnd.google-apps.spreadsheet":
            results.append(
                download_doc(item_id, "spreadsheets", output_dir, account, known_title=item_name)
            )

        else:
            results.append(
                download_drive_file(item_id, output_dir, account, known_name=item_name)
            )

    return results
