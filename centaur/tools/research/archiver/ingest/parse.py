#!/usr/bin/env python3
"""Reducto parse/extract adapter for parchiver."""

from __future__ import annotations

import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx

from centaur_sdk import secret

from ..utils import compute_file_hash, file_record_to_dict

REDUCTO_API_KEY = secret("REDUCTO_API_KEY", "")

REDUCTO_UPLOAD_URL = "https://platform.reducto.ai/upload"
REDUCTO_PARSE_ASYNC_URL = "https://platform.reducto.ai/parse_async"
REDUCTO_EXTRACT_ASYNC_URL = "https://platform.reducto.ai/extract_async"
REDUCTO_JOB_URL = "https://platform.reducto.ai/job"

JOB_POLL_INTERVAL = 2
PARSE_JOB_TIMEOUT_S = int(os.getenv("PARSE_TIMEOUT_S", "300"))  # noqa: TID251
EXTRACT_JOB_TIMEOUT_S = int(os.getenv("EXTRACT_TIMEOUT_S", str(PARSE_JOB_TIMEOUT_S)))  # noqa: TID251


def _env_enabled(name: str, default: bool) -> bool:
    value = os.getenv(name)  # noqa: TID251
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


EXTRACT_OPTIMIZE_FOR_LATENCY = _env_enabled(
    "EXTRACT_OPTIMIZE_FOR_LATENCY",
    default=True,
)

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "company": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Company or startup name"},
                "aliases": {"type": "array", "items": {"type": "string"}},
                "website": {"type": "string", "description": "Company website URL"},
            },
            "required": ["name"],
        },
        "deal": {
            "type": "object",
            "properties": {
                "round_label": {
                    "type": "string",
                    "enum": [
                        "Pre-Seed",
                        "Seed",
                        "Series A",
                        "Series B",
                        "Series C",
                        "Growth",
                        "Token Round",
                        "M&A",
                        "Unknown",
                    ],
                },
                "round_freeform": {"type": "string"},
                "amount_usd": {"type": "number"},
                "valuation_usd": {"type": "number"},
            },
        },
        "document": {
            "type": "object",
            "properties": {
                "doc_type": {
                    "type": "string",
                    "enum": [
                        "PitchDeck",
                        "InvestorMemo",
                        "OnePager",
                        "TermSheet",
                        "FinancialModel",
                        "InvestorUpdate",
                        "NDA",
                        "DataroomFile",
                        "Other",
                    ],
                },
                "title": {"type": "string"},
                "date": {"type": "string"},
            },
        },
        "summary": {
            "type": "object",
            "properties": {
                "one_liner": {"type": "string"},
                "sector_tags": {"type": "array", "items": {"type": "string"}},
                "geo": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
    "required": ["company", "document"],
}

EXTRACT_PROMPT = """Extract key metadata from this pitch deck or investment document.
Focus on identifying:
- The company name (look for logos, headers, \"About Us\" sections)
- The funding round (Pre-Seed, Seed, Series A, etc.)
- Document type (pitch deck, memo, term sheet, etc.)
- A brief one-liner summary of what the company does
- Relevant sector/industry tags

If information is not clearly present, use null or \"Unknown\"."""


def _check_env() -> None:
    if not REDUCTO_API_KEY:
        raise RuntimeError("Missing Reducto API key: set REDUCTO_API_KEY")


def upload_to_reducto(file_path: Path) -> str:
    with open(file_path, "rb") as handle:
        response = httpx.post(
            REDUCTO_UPLOAD_URL,
            headers={"Authorization": f"Bearer {REDUCTO_API_KEY}"},
            files={"file": (file_path.name, handle)},
        )
    response.raise_for_status()
    file_id = response.json()["file_id"]
    return file_id


def submit_parse_job(file_id: str) -> str:
    response = httpx.post(
        REDUCTO_PARSE_ASYNC_URL,
        headers={
            "Authorization": f"Bearer {REDUCTO_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "input": file_id,
            "retrieval": {
                "chunking": {"chunk_mode": "variable"},
                "filter_blocks": ["Header", "Footer", "Page Number"],
            },
        },
    )
    response.raise_for_status()
    job_id = response.json()["job_id"]
    return job_id


def submit_extract_job(file_id: str) -> str:
    response = httpx.post(
        REDUCTO_EXTRACT_ASYNC_URL,
        headers={
            "Authorization": f"Bearer {REDUCTO_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "input": file_id,
            "instructions": {
                "schema": EXTRACT_SCHEMA,
                "system_prompt": EXTRACT_PROMPT,
            },
            "settings": {
                "optimize_for_latency": EXTRACT_OPTIMIZE_FOR_LATENCY,
            },
        },
    )
    response.raise_for_status()
    job_id = response.json()["job_id"]
    return job_id


def get_job_status(job_id: str) -> dict:
    response = httpx.get(
        f"{REDUCTO_JOB_URL}/{job_id}",
        headers={"Authorization": f"Bearer {REDUCTO_API_KEY}"},
    )
    response.raise_for_status()
    return response.json()


def wait_for_job(job_id: str, timeout: int = 300) -> dict:
    start = time.time()
    while True:
        job = get_job_status(job_id)
        status = job.get("status")
        if status in ("Completed", "Failed"):
            return job
        if time.time() - start > timeout:
            raise TimeoutError(f"Job {job_id} timeout after {timeout}s")
        time.sleep(JOB_POLL_INTERVAL)


def _extract_chunks(parse_job: dict) -> list[dict]:
    result = parse_job.get("result", {})
    inner = result.get("result", {}) if isinstance(result, dict) else {}
    if inner.get("type") == "url":
        try:
            return httpx.get(inner["url"]).json()
        except Exception:
            return []
    return inner.get("chunks", [])


def _extract_metadata(extract_job: dict) -> dict:
    result = extract_job.get("result", {})
    inner = result.get("result", {}) if isinstance(result, dict) else {}
    if isinstance(inner, list) and inner:
        return inner[0] if isinstance(inner[0], dict) else {}
    if isinstance(inner, dict):
        return inner
    return {}


def _normalize_chunks(chunks_data: list[dict]) -> tuple[list[dict], str]:
    chunks = []
    full_text_parts = []
    for i, chunk in enumerate(chunks_data):
        text = chunk.get("embed") or chunk.get("content", "")
        if not text.strip():
            continue
        page = 1
        if chunk.get("blocks"):
            page = chunk["blocks"][0].get("bbox", {}).get("page", 1)
        chunks.append({"page": page, "chunk_index": i, "text": text})
        full_text_parts.append(text)
    full_text = "\n\n".join(full_text_parts)
    return chunks, full_text


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


SUPPORTED_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".tiff", ".bmp", ".webp",
    ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
}


def parse_manifest(manifest_path: Path) -> dict:
    _check_env()
    data = json.loads(manifest_path.read_text())
    source_context = data.get("context")
    files = data.get("files", [])
    results = []
    # Jobs pending poll: list of (index, entry, file_id, parse_job_id, extract_job_id)
    pending_jobs: list[tuple[int, dict, str, str, str]] = []

    # --- Phase 1: validate + upload + submit (sequential) ---
    for entry in files:
        if entry.get("status") not in ("ok", "partial"):
            results.append({
                "status": "skipped",
                "error": entry.get("error", "Entry not ok"),
                "file": entry,
            })
            continue

        raw_path = entry.get("file_path", "")
        if not raw_path or raw_path == ".":
            results.append({
                "status": "error",
                "error": "Empty file path",
                "file": entry,
            })
            continue

        file_path = Path(raw_path)
        if not file_path.exists():
            results.append({
                "status": "error",
                "error": "File not found",
                "file": entry,
            })
            continue

        if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            results.append({
                "status": "skipped",
                "error": f"Unsupported file type: {file_path.suffix}",
                "file": entry,
            })
            continue

        file_id = upload_to_reducto(file_path)
        parse_job_id = submit_parse_job(file_id)
        extract_job_id = submit_extract_job(file_id)
        # placeholder — will be replaced after polling
        idx = len(results)
        results.append(None)
        pending_jobs.append((idx, entry, file_id, parse_job_id, extract_job_id))

    # --- Phase 2: poll all jobs in parallel ---
    if pending_jobs:
        max_workers = min(len(pending_jobs) * 2, 10)

        def _poll_parse_job(job_id: str) -> dict:
            return wait_for_job(job_id, timeout=PARSE_JOB_TIMEOUT_S)

        def _poll_extract_job(job_id: str) -> dict:
            return wait_for_job(job_id, timeout=EXTRACT_JOB_TIMEOUT_S)

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            # Submit all poll futures
            parse_futures = {
                idx: pool.submit(_poll_parse_job, parse_job_id)
                for idx, _, _, parse_job_id, _ in pending_jobs
            }
            extract_futures = {
                idx: pool.submit(_poll_extract_job, extract_job_id)
                for idx, _, _, _, extract_job_id in pending_jobs
            }

        # Collect results
        for idx, entry, file_id, parse_job_id, extract_job_id in pending_jobs:
            try:
                parse_job = parse_futures[idx].result()
                if parse_job.get("status") == "Failed":
                    raise RuntimeError(f"Parse job failed: {parse_job_id}")

                extract_job = None
                metadata = {}
                extract_error = None
                try:
                    extract_job = extract_futures[idx].result()
                    if extract_job.get("status") == "Failed":
                        raise RuntimeError(f"Extract job failed: {extract_job_id}")
                    metadata = _extract_metadata(extract_job)
                except Exception as exc:
                    extract_error = str(exc)

                chunks_data = _extract_chunks(parse_job)
                chunks, full_text = _normalize_chunks(chunks_data)
                content_hash = _hash_text(full_text) if full_text else None
                file_context = entry.get("context")
                results[idx] = {
                    "status": "ok",
                    "file": entry,
                    "reducto_file_id": file_id,
                    "parse_job_id": parse_job_id,
                    "extract_job_id": extract_job_id,
                    "parse_json": parse_job,
                    "extract_json": extract_job,
                    "metadata": metadata,
                    "chunks": chunks,
                    "parsed_text": full_text,
                    "content_hash": content_hash,
                    "context": file_context,
                }
                if extract_error:
                    results[idx]["warnings"] = [f"extract_failed: {extract_error}"]
                    results[idx]["extract_error"] = extract_error
            except Exception as exc:
                results[idx] = {
                    "status": "error",
                    "error": str(exc),
                    "file": entry,
                }

    return {
        "status": "ok",
        "source": data.get("source_url"),
        "context": source_context,
        "files": results,
    }
