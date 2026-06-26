#!/usr/bin/env python3
"""Download adapters for parchiver."""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import os
import zipfile
from pathlib import Path
from typing import Any

from ..utils import (
    FileRecord,
    compute_file_hash,
    detect_mime_type,
    file_record_to_dict,
    normalize_url,
)
from .docsend import route_all_docsends
from .google import (
    DownloadResult,
    download_doc,
    download_drive_file,
    download_folder,
    parse_google_url,
)

MANUAL_DOWNLOAD_SUGGESTION = (
    "If this source keeps failing, please download the file or ZIP manually and share it with us."
)

_DOCSEND_BLOCKER_INPUTS = {
    "passcode_required": "password",
    "email_required": "email",
    "verification_link_required": "verification_link",
}

_DOCSEND_FALLBACK_ERROR_HINTS = (
    "browser_use_api_key",
    "router returned no results",
    "cloudfront",
    "blocked",
    "waf",
    "http_403",
    "http_429",
    "http_503",
)


def _with_manual_download_suggestion(error: str | None) -> str | None:
    if not error:
        return error
    if MANUAL_DOWNLOAD_SUGGESTION in error:
        return error
    if error.endswith((".", "!", "?")):
        return f"{error} {MANUAL_DOWNLOAD_SUGGESTION}"
    return f"{error}. {MANUAL_DOWNLOAD_SUGGESTION}"


def _normalize_docsend_status(status: str | None) -> str | None:
    if not status:
        return status
    if status == "password_required":
        return "passcode_required"
    if status == "link_expired":
        return "expired"
    return status


def _docsend_blocker(status: str | None, error: str | None) -> dict[str, str] | None:
    normalized = _normalize_docsend_status(status)
    if normalized not in {
        "passcode_required",
        "email_required",
        "verification_link_required",
        "blocked",
        "expired",
    }:
        return None

    blocker = {
        "kind": normalized,
        "message": error or normalized.replace("_", " "),
    }
    required_input = _DOCSEND_BLOCKER_INPUTS.get(normalized)
    if required_input:
        blocker["required_input"] = required_input
    return blocker


def _should_fallback_to_standalone_docsend(error: str | None) -> bool:
    lowered = (error or "").lower()
    return any(hint in lowered for hint in _DOCSEND_FALLBACK_ERROR_HINTS)


def _load_standalone_docsend_client() -> Any:
    client_path = Path(__file__).resolve().parents[2] / "docsend" / "client.py"
    spec = importlib.util.spec_from_file_location(
        "shared.tools_runtime.archiver._docsend_standalone_client",
        client_path,
    )
    if not spec or not spec.loader:
        raise RuntimeError(f"Unable to load standalone DocSend client from {client_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.DocsendClient()


def _build_docsend_payload(
    *,
    source_url: str,
    company_name: str,
    status: str,
    error: str | None,
    files: list[dict],
    strategy: str,
    total_pages: int | None = None,
    downloaded: int | None = None,
    failed_slides: list[Any] | None = None,
) -> dict:
    normalized_status = _normalize_docsend_status(status) or "error"
    blocker = _docsend_blocker(normalized_status, error)
    surfaced_error = error
    if status != "ok" and not blocker:
        surfaced_error = _with_manual_download_suggestion(error)

    payload = {
        "status": "ok" if status == "ok" else "error",
        "error": surfaced_error,
        "files": files,
        "docsend": {
            "status": normalized_status,
            "strategy": strategy,
            "total_pages": total_pages,
            "downloaded": downloaded,
            "failed_slides": failed_slides or [],
        },
    }
    if blocker:
        payload["blocker"] = blocker
    return payload


def _save_docsend_client_download(
    result: dict,
    *,
    output_dir: Path,
    source_url: str,
    company_name: str,
) -> list[dict]:
    data = result.get("data")
    if not data:
        return []

    filename = result.get("filename") or f"{company_name}.pdf"
    path = output_dir / filename
    path.write_bytes(base64.b64decode(data))
    record = _build_file_record(
        path,
        source_url,
        "docsend",
        title=company_name,
        status="partial" if result.get("error") else "ok",
        error=result.get("error"),
    )
    return [file_record_to_dict(record)]


def _run_standalone_docsend_fallback(
    *,
    source_url: str,
    output_dir: Path,
    company_name: str,
    password: str | None,
    email: str | None,
) -> dict:
    client = _load_standalone_docsend_client()
    result = client.download(
        url=source_url,
        email=email or os.getenv("DOCSEND_EMAIL", ""),  # noqa: TID251
        passcode=password,
    )
    files = _save_docsend_client_download(
        result,
        output_dir=output_dir,
        source_url=source_url,
        company_name=company_name,
    )
    status = "ok" if result.get("status") == "ok" and files else (result.get("status") or "error")
    return _build_docsend_payload(
        source_url=source_url,
        company_name=company_name,
        status=status,
        error=result.get("error"),
        files=files,
        strategy="standalone_client",
        total_pages=result.get("page_count"),
        downloaded=result.get("downloaded"),
    )


def _fallback_docsend_payload(
    *,
    source_url: str,
    output_dir: Path,
    company_name: str,
    password: str | None,
    email: str | None,
    original_error: str,
) -> dict:
    try:
        return _run_standalone_docsend_fallback(
            source_url=source_url,
            output_dir=output_dir,
            company_name=company_name,
            password=password,
            email=email,
        )
    except Exception as exc:
        combined_error = original_error if str(exc) in original_error else f"{original_error}; fallback failed: {exc}"
        return _build_docsend_payload(
            source_url=source_url,
            company_name=company_name,
            status="error",
            error=combined_error,
            files=[],
            strategy="fallback_unavailable",
        )


def _build_file_record(
    path: Path,
    source_url: str,
    source_type: str,
    title: str | None = None,
    relative_path: str | None = None,
    status: str = "ok",
    error: str | None = None,
) -> FileRecord:
    file_hash = compute_file_hash(path)
    size_bytes = path.stat().st_size
    mime_type = detect_mime_type(path)
    return FileRecord(
        source_url=source_url,
        source_type=source_type,
        file_path=str(path),
        filename=path.name,
        file_hash=file_hash,
        size_bytes=size_bytes,
        mime_type=mime_type,
        title=title,
        relative_path=relative_path,
        status=status,
        error=error,
    )


async def _download_docsend_async(
    source_url: str,
    output_dir: Path,
    company: str | None,
    password: str | None,
    email: str | None,
) -> dict:
    company_name = company or "unknown"
    results = await route_all_docsends(
        [{"url": source_url, "company": company_name, "password": password}],
        output_dir=output_dir,
        email=email or os.getenv("DOCSEND_EMAIL", ""),  # noqa: TID251
    )
    if not results:
        return _fallback_docsend_payload(
            source_url=source_url,
            output_dir=output_dir,
            company_name=company_name,
            password=password,
            email=email,
            original_error="DocSend router returned no results",
        )

    result = results[0]
    router_status = "ok" if result.status.value in ("success", "partial") else result.status.value
    files: list[dict] = []
    if result.pdf_path:
        path = Path(result.pdf_path)
        if path.exists():
            # Expand ZIP files into individual parseable files
            if path.suffix.lower() == ".zip":
                expanded = _expand_zip(path, source_url, "docsend", company_name)
                if expanded:
                    files.extend(expanded)
                else:
                    # ZIP had no parseable files, keep the ZIP record
                    record = _build_file_record(
                        path, source_url, "docsend", title=company_name,
                        status="ok" if router_status == "ok" else "partial",
                        error=result.error,
                    )
                    files.append(file_record_to_dict(record))
            else:
                record = _build_file_record(
                    path, source_url, "docsend", title=company_name,
                    status="ok" if router_status == "ok" else "partial",
                    error=result.error,
                )
                files.append(file_record_to_dict(record))
    payload = _build_docsend_payload(
        source_url=source_url,
        company_name=company_name,
        status=router_status,
        error=result.error,
        files=files,
        strategy="router",
        total_pages=result.total_pages,
        downloaded=result.downloaded,
        failed_slides=result.failed_slides,
    )
    if payload["status"] == "ok" or not _should_fallback_to_standalone_docsend(result.error):
        return payload
    return _fallback_docsend_payload(
        source_url=source_url,
        output_dir=output_dir,
        company_name=company_name,
        password=password,
        email=email,
        original_error=result.error or "DocSend router failed",
    )


_ZIP_PARSEABLE_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".tiff", ".bmp", ".webp",
    ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
}


def _expand_zip(
    zip_path: Path,
    source_url: str,
    source_type: str,
    title: str | None,
) -> list[dict]:
    """Extract a ZIP and return file records for each supported file inside."""
    extract_dir = zip_path.parent / (zip_path.stem + "_extracted")
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(extract_dir)

    records: list[dict] = []
    for path in sorted(extract_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in _ZIP_PARSEABLE_EXTENSIONS:
            continue
        if path.name.startswith(".") or "__MACOSX" in str(path):
            continue
        relative = str(path.relative_to(extract_dir))
        record = _build_file_record(
            path,
            source_url,
            source_type,
            title=title,
            relative_path=relative,
        )
        records.append(file_record_to_dict(record))
    return records


def download_docsend(
    source_url: str,
    output_dir: Path,
    company: str | None,
    password: str | None,
    email: str | None,
) -> dict:
    return asyncio.run(
        _download_docsend_async(
            source_url=source_url,
            output_dir=output_dir,
            company=company,
            password=password,
            email=email,
        )
    )


def _record_from_download_result(
    result: DownloadResult,
    source_url: str,
    source_type: str,
    base_dir: Path,
) -> FileRecord | None:
    if result.status != "ok" or not result.output_path:
        return FileRecord(
            source_url=source_url,
            source_type=source_type,
            file_path=result.output_path or "",
            filename=Path(result.output_path or "unknown").name,
            file_hash="",
            size_bytes=0,
            mime_type=None,
            title=result.title,
            status=result.status if result.status in ("forbidden", "not_found") else "error",
            error=_with_manual_download_suggestion(result.error),
        )

    path = Path(result.output_path)
    relative_path = str(path.relative_to(base_dir)) if path.exists() else None
    return _build_file_record(
        path,
        source_url,
        source_type,
        title=result.title,
        relative_path=relative_path,
    )


def download_google(
    source_url: str,
    output_dir: Path,
    account: str,
    max_depth: int,
) -> dict:
    parsed = parse_google_url(source_url)
    if not parsed:
        return {
            "status": "error",
            "error": "Unsupported Google URL",
            "files": [],
        }

    file_id, link_type = parsed
    google_dir = output_dir / "google"
    google_dir.mkdir(parents=True, exist_ok=True)

    files: list[dict] = []
    status = "ok"
    error = None

    if link_type == "folder":
        folder_dir = google_dir / "folders" / file_id
        folder_dir.mkdir(parents=True, exist_ok=True)
        results = download_folder(file_id, folder_dir, account, max_depth=max_depth)
        for result in results:
            record = _record_from_download_result(result, source_url, "google_drive", folder_dir)
            if record:
                files.append(file_record_to_dict(record))
            if result.status != "ok":
                status = "partial"
    else:
        file_dir = google_dir / "files" / file_id
        file_dir.mkdir(parents=True, exist_ok=True)
        if link_type in ("document", "presentation", "spreadsheets"):
            result = download_doc(file_id, link_type, file_dir, account)
        else:
            result = download_drive_file(file_id, file_dir, account)
        record = _record_from_download_result(result, source_url, "google_drive", file_dir)
        if record:
            files.append(file_record_to_dict(record))
        if result.status != "ok":
            status = "error"
            error = _with_manual_download_suggestion(result.error)

    return {
        "status": status,
        "error": error,
        "files": files,
        "google": {
            "link_type": link_type,
            "file_id": file_id,
        },
    }


def download_source(
    source_url: str,
    output_dir: Path,
    company: str | None,
    account: str | None,
    password: str | None,
    email: str | None,
    max_depth: int,
) -> dict:
    canonical_url = normalize_url(source_url)
    output_dir.mkdir(parents=True, exist_ok=True)
    if "docsend.com" in canonical_url:
        docsend_dir = output_dir / "docsend"
        docsend_dir.mkdir(parents=True, exist_ok=True)
        payload = download_docsend(source_url, docsend_dir, company, password, email)
        response = {
            "status": payload["status"],
            "error": payload.get("error"),
            "source_url": source_url,
            "canonical_url": canonical_url,
            "source_type": "docsend",
            "files": payload["files"],
            "details": payload.get("docsend"),
        }
        if payload.get("blocker"):
            response["blocker"] = payload["blocker"]
        return response

    if "google.com" in canonical_url:
        if not account:
            return {
                "status": "error",
                "error": "Google download requires --account",
                "source_url": source_url,
                "canonical_url": canonical_url,
                "source_type": "google_drive",
                "files": [],
            }
        payload = download_google(source_url, output_dir, account, max_depth)
        return {
            "status": payload["status"],
            "error": (
                _with_manual_download_suggestion(payload.get("error"))
                if payload["status"] != "ok"
                else payload.get("error")
            ),
            "source_url": source_url,
            "canonical_url": canonical_url,
            "source_type": "google_drive",
            "files": payload["files"],
            "details": payload.get("google"),
        }

    return {
        "status": "error",
        "error": "Unsupported source type for parchiver download",
        "source_url": source_url,
        "canonical_url": canonical_url,
        "source_type": "unknown",
        "files": [],
    }
