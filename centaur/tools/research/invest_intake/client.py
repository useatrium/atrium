"""Input normalization helper for invest persona."""

from __future__ import annotations

import importlib.util
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


class InvestIntakeClient:
    """Normalize mixed links/files into one context pack."""

    _MAX_PARALLEL = 6

    def _load_archiver_client(self):
        import sys

        candidate_roots = [
            Path("/app/tools/research/archiver"),
            Path(__file__).resolve().parent.parent / "archiver",
        ]
        archiver_dir = next((p for p in candidate_roots if (p / "client.py").exists()), None)
        if archiver_dir is None:
            raise RuntimeError("archiver package not found")

        parent = str(archiver_dir.parent)
        if parent not in sys.path:
            sys.path.insert(0, parent)

        module_name = archiver_dir.name
        module = importlib.import_module(f"{module_name}.client")
        return module.ArchiverClient()

    @staticmethod
    def _dedupe(values: list[str] | None) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for value in values or []:
            item = (value or "").strip()
            if not item:
                continue
            if item in seen:
                continue
            seen.add(item)
            out.append(item)
        return out

    @staticmethod
    def _classify_url(raw_url: str) -> str:
        parsed = urlparse(raw_url)
        host = (parsed.netloc or "").lower()
        if "docsend.com" in host:
            return "docsend"
        if "docs.google.com" in host:
            return "google_docs"
        if "drive.google.com" in host:
            return "google_drive"
        if parsed.scheme in {"http", "https"}:
            return "web"
        return "unknown"

    @staticmethod
    def _classify_file(path: str) -> str:
        suffix = Path(path).suffix.lower()
        if suffix in {".csv", ".tsv"}:
            return "tabular"
        if suffix in {".xls", ".xlsx"}:
            return "spreadsheet"
        if suffix in {".ppt", ".pptx"}:
            return "slides"
        if suffix in {".doc", ".docx"}:
            return "document"
        if suffix in {".pdf"}:
            return "pdf"
        if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            return "image"
        return "file"

    _ARCHIVER_KINDS = {"docsend", "google_docs", "google_drive"}

    def _extract_url(
        self,
        *,
        archiver: Any,
        source_url: str,
        output_root: Path,
        company: str | None,
        max_depth: int,
    ) -> dict[str, Any]:
        kind = self._classify_url(source_url)

        if kind not in self._ARCHIVER_KINDS:
            return {
                "source": source_url,
                "kind": kind,
                "status": "needs_websearch",
                "hint": (
                    "Generic web URL — archiver does not handle this. "
                    "Fetch it via `websearch search` / `websearch deep_research` instead."
                ),
                "result": {},
            }

        slug = source_url.replace("://", "_").replace("/", "_")[:64]
        output_dir = output_root / slug
        output_dir.mkdir(parents=True, exist_ok=True)
        try:
            payload = archiver.extract_source(
                source_url=source_url,
                output_dir=str(output_dir),
                company=company,
                max_depth=max_depth,
            )
            return {
                "source": source_url,
                "kind": kind,
                "status": payload.get("status", "unknown"),
                "result": payload,
            }
        except Exception as exc:
            return {
                "source": source_url,
                "kind": kind,
                "status": "error",
                "error": str(exc),
                "result": {},
            }

    def _extract_files(self, *, archiver: Any, file_paths: list[str]) -> dict[str, Any]:
        if not file_paths:
            return {"status": "skipped", "files": []}
        try:
            payload = archiver.extract_files(file_paths=file_paths)
            return {"status": payload.get("status", "unknown"), "result": payload}
        except Exception as exc:
            return {"status": "error", "error": str(exc), "result": {}}

    def normalize(
        self,
        urls: list[str] | None = None,
        file_paths: list[str] | None = None,
        company: str | None = None,
        max_depth: int = 3,
        parallelism: int = 4,
        include_raw_payload: bool = False,
    ) -> dict[str, Any]:
        """Normalize and parse mixed URLs/files into one context pack."""
        deduped_urls = self._dedupe(urls)
        deduped_files = self._dedupe(file_paths)
        parallel = max(1, min(parallelism, self._MAX_PARALLEL))
        output_root = Path(tempfile.mkdtemp(prefix="invest-intake-"))

        archiver = self._load_archiver_client()

        url_results: list[dict[str, Any]] = []
        if deduped_urls:
            with ThreadPoolExecutor(max_workers=parallel) as executor:
                futures = [
                    executor.submit(
                        self._extract_url,
                        archiver=archiver,
                        source_url=url,
                        output_root=output_root,
                        company=company,
                        max_depth=max_depth,
                    )
                    for url in deduped_urls
                ]
                for future in as_completed(futures):
                    url_results.append(future.result())

        file_result = self._extract_files(archiver=archiver, file_paths=deduped_files)

        artifacts: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        deferred: list[dict[str, Any]] = []
        for item in url_results:
            result = item.get("result", {})
            files = result.get("files", []) if isinstance(result, dict) else []
            status_code = item.get("status")
            artifact: dict[str, Any] = {
                "source": item.get("source"),
                "kind": item.get("kind"),
                "status": status_code,
                "file_count": len(files),
            }
            if status_code == "needs_websearch":
                artifact["hint"] = item.get("hint")
                deferred.append(artifact)
            artifacts.append(artifact)
            if status_code not in ("ok", "needs_websearch"):
                errors.append(
                    {
                        "source": item.get("source"),
                        "error": item.get("error") or result.get("error") or "unknown error",
                    }
                )

        file_payload = file_result.get("result", {}) if isinstance(file_result, dict) else {}
        file_entries = file_payload.get("files", []) if isinstance(file_payload, dict) else []
        for path in deduped_files:
            artifacts.append(
                {
                    "source": path,
                    "kind": self._classify_file(path),
                    "status": file_result.get("status", "unknown"),
                    "file_count": 1,
                }
            )
        if file_result.get("status") == "error":
            errors.append(
                {"source": "file_paths", "error": file_result.get("error", "file extraction failed")}
            )

        status = "ok" if not errors else ("partial" if artifacts else "error")

        response: dict[str, Any] = {
            "status": status,
            "summary": {
                "urls_received": len(deduped_urls),
                "files_received": len(deduped_files),
                "artifacts_processed": len(artifacts),
                "errors": len(errors),
                "deferred_to_websearch": len(deferred),
            },
            "artifacts": artifacts,
            "output_root": str(output_root),
            "errors": errors,
            "deferred_to_websearch": deferred,
            "next_actions": [
                "Generate 1-5 MIQs from extracted evidence",
                "Run web and internal-prior grounding searches",
                "Offer go-deep, refine, or redirect next step",
            ],
        }

        if include_raw_payload:
            response["raw"] = {
                "urls": url_results,
                "files": file_payload,
                "file_entries": file_entries,
            }

        return response


def _client() -> InvestIntakeClient:
    return InvestIntakeClient()

