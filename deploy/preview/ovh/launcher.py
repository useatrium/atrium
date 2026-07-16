#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hmac
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
PREVIEWCTL = ROOT / "deploy" / "preview" / "ovh" / "previewctl.py"
DEFAULT_STATE_DIR = ROOT / "deploy" / "preview" / "ovh" / ".state"
PREVIEW_STATE_DIR = Path(os.environ.get("ATRIUM_PREVIEW_STATE_DIR", DEFAULT_STATE_DIR))
DEFAULT_DB = PREVIEW_STATE_DIR / "launcher.sqlite3"
DEFAULT_TTL_HOURS = 24
MAX_TTL_HOURS = 72
DEFAULT_MAX_CONCURRENT_PREVIEWS = 3
ALLOWED_REPOS = {"useatrium/atrium"}
ACTIVE_STATUSES = ("provisioning", "ready")


class CapacityExceeded(RuntimeError):
    pass


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat()


def run(cmd: list[str], *, timeout: int = 120) -> str:
    proc = subprocess.run(
        cmd,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(detail or f"command failed: {' '.join(cmd)}")
    return proc.stdout


def resolve_commit(ref: str) -> str:
    return run(["git", "rev-parse", f"{ref}^{{commit}}"], timeout=30).strip()


def fetch_and_resolve_commit(repo: str, ref: str) -> str:
    if repo not in ALLOWED_REPOS:
        raise ValueError(f"repo is not allowed: {repo}")
    if re.fullmatch(r"[0-9a-f]{40}", ref):
        run(["git", "fetch", "--quiet", "origin", ref], timeout=120)
        return resolve_commit(ref)

    branch = ref.removeprefix("refs/heads/")
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", branch) or branch.startswith("-") or ".." in branch:
        raise ValueError("ref is not a valid branch name")
    remote_ref = f"refs/remotes/origin/{branch}"
    try:
        run(
            ["git", "fetch", "--quiet", "origin", f"refs/heads/{branch}:{remote_ref}"],
            timeout=120,
        )
    except RuntimeError:
        if branch != "main":
            raise
        branch = remote_default_branch()
        remote_ref = f"refs/remotes/origin/{branch}"
        run(
            ["git", "fetch", "--quiet", "origin", f"refs/heads/{branch}:{remote_ref}"],
            timeout=120,
        )
    return resolve_commit(remote_ref)


def remote_default_branch() -> str:
    output = run(["git", "ls-remote", "--symref", "origin", "HEAD"], timeout=30)
    for line in output.splitlines():
        if line.startswith("ref: refs/heads/") and line.endswith("\tHEAD"):
            return line.removeprefix("ref: refs/heads/").removesuffix("\tHEAD")
    raise RuntimeError("could not determine remote default branch")


def first_json_object(text: str) -> dict[str, Any]:
    start = text.find("{")
    if start < 0:
        raise ValueError("command output did not contain JSON")
    depth = 0
    in_string = False
    escape = False
    for index, char in enumerate(text[start:], start=start):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                value = json.loads(text[start : index + 1])
                if not isinstance(value, dict):
                    raise ValueError("command JSON was not an object")
                return value
    raise ValueError("command output contained incomplete JSON")


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.init()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS previews (
                  id TEXT PRIMARY KEY,
                  repo TEXT NOT NULL,
                  ref TEXT NOT NULL,
                  commit_sha TEXT,
                  url TEXT,
                  initial_url TEXT,
                  status TEXT NOT NULL,
                  requested_by TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  failure_message TEXT,
                  phase TEXT,
                  phase_time TEXT,
                  ready_at TEXT
                )
                """
            )

    def reserve(self, preview: dict[str, Any], cap: int) -> None:
        fields = self._fields(preview)
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
            active = db.execute(
                f"SELECT COUNT(*) FROM previews WHERE status IN ({placeholders})",  # noqa: S608
                ACTIVE_STATUSES,
            ).fetchone()[0]
            if active >= cap:
                raise CapacityExceeded(f"maximum concurrent previews ({cap}) reached")
            self._execute_upsert(db, fields)

    def upsert(self, preview: dict[str, Any]) -> None:
        with self.lock, self.connect() as db:
            self._execute_upsert(db, self._fields(preview))

    @staticmethod
    def _fields(preview: dict[str, Any]) -> dict[str, Any]:
        return {
            name: preview.get(name)
            for name in (
                "id",
                "repo",
                "ref",
                "commit_sha",
                "url",
                "initial_url",
                "status",
                "requested_by",
                "created_at",
                "updated_at",
                "expires_at",
                "failure_message",
                "phase",
                "phase_time",
                "ready_at",
            )
        }

    @staticmethod
    def _execute_upsert(db: sqlite3.Connection, fields: dict[str, Any]) -> None:
        db.execute(
            """
            INSERT INTO previews
              (id, repo, ref, commit_sha, url, initial_url, status, requested_by,
               created_at, updated_at, expires_at, failure_message, phase, phase_time, ready_at)
            VALUES
              (:id, :repo, :ref, :commit_sha, :url, :initial_url, :status, :requested_by,
               :created_at, :updated_at, :expires_at, :failure_message, :phase, :phase_time, :ready_at)
            ON CONFLICT(id) DO UPDATE SET
              repo=excluded.repo, ref=excluded.ref, commit_sha=excluded.commit_sha,
              url=excluded.url, initial_url=excluded.initial_url, status=excluded.status,
              requested_by=excluded.requested_by, updated_at=excluded.updated_at,
              expires_at=excluded.expires_at, failure_message=excluded.failure_message,
              phase=excluded.phase, phase_time=excluded.phase_time, ready_at=excluded.ready_at
            """,
            fields,
        )

    def get(self, preview_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM previews WHERE id = ?", (preview_id,)).fetchone()
        return dict(row) if row else None

    def list_active(self) -> list[dict[str, Any]]:
        """Every preview currently holding a slot, soonest-to-expire first.

        Deliberately store-only. `status()` shells out to previewctl per preview,
        which is fine for one but would make listing the whole box take minutes.
        A caller who needs authoritative phase for a single preview asks for it.
        """
        placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
        with self.connect() as db:
            rows = db.execute(
                f"SELECT * FROM previews WHERE status IN ({placeholders}) ORDER BY expires_at",  # noqa: S608
                ACTIVE_STATUSES,
            ).fetchall()
        return [dict(row) for row in rows]

    def list_expired(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM previews WHERE expires_at <= ? AND status IN ('provisioning', 'ready')",
                (iso(utc_now()),),
            ).fetchall()
        return [dict(row) for row in rows]


class Launcher:
    def __init__(self, store: Store, max_concurrent: int = DEFAULT_MAX_CONCURRENT_PREVIEWS):
        if max_concurrent < 1:
            raise ValueError("MAX_CONCURRENT_PREVIEWS must be at least 1")
        self.store = store
        self.max_concurrent = max_concurrent

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        repo = str(body.get("repo") or "useatrium/atrium")
        ref = str(body.get("ref") or body.get("branch") or body.get("commit_sha") or "").strip()
        if not ref:
            raise ValueError("ref, branch, or commit_sha is required")
        if repo not in ALLOWED_REPOS:
            raise ValueError(f"repo is not allowed: {repo}")
        try:
            ttl_hours = int(body["ttl_hours"]) if "ttl_hours" in body else DEFAULT_TTL_HOURS
        except (TypeError, ValueError) as err:
            raise ValueError("ttl_hours must be an integer") from err
        if ttl_hours < 1 or ttl_hours > MAX_TTL_HOURS:
            raise ValueError(f"ttl_hours must be between 1 and {MAX_TTL_HOURS}")

        supplied_sha = str(body.get("commit_sha") or "")
        if supplied_sha:
            if not re.fullmatch(r"[0-9a-f]{40}", supplied_sha):
                raise ValueError("commit_sha must be 40 lowercase hexadecimal characters")
            commit_sha = supplied_sha
        elif body.get("fetch", True):
            commit_sha = fetch_and_resolve_commit(repo, ref)
        else:
            commit_sha = resolve_commit(ref)

        # The controller owns ID generation so the API can return immediately.
        import importlib.util

        spec = importlib.util.spec_from_file_location("atrium_ovh_previewctl", PREVIEWCTL)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load OVH preview controller")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        preview_id = module.make_preview_id(commit_sha)

        now = utc_now()
        record = {
            "id": preview_id,
            "repo": repo,
            "ref": ref,
            "commit_sha": commit_sha,
            "url": None,
            "initial_url": None,
            "status": "provisioning",
            "requested_by": body.get("requested_by"),
            "created_at": iso(now),
            "updated_at": iso(now),
            "expires_at": iso(now + dt.timedelta(hours=ttl_hours)),
            "failure_message": None,
            "phase": "packages",
            "phase_time": iso(now),
            "ready_at": None,
        }
        self.store.reserve(record, self.max_concurrent)
        thread = threading.Thread(
            target=self._create_worker,
            args=(record, ttl_hours),
            name=f"create-{preview_id}",
            daemon=True,
        )
        thread.start()
        return {"id": preview_id, "phase": "packages"}

    def _create_worker(self, record: dict[str, Any], ttl_hours: int) -> None:
        try:
            output = run(
                [
                    sys.executable,
                    str(PREVIEWCTL),
                    "create",
                    record["commit_sha"],
                    "--preview-id",
                    record["id"],
                    "--ttl-hours",
                    str(ttl_hours),
                ],
                timeout=7200,
            )
            current = first_json_object(output)
            self._merge_controller_status(record, current)
        except Exception as err:
            record.update(
                {
                    "status": "failed",
                    "phase": "failed",
                    "phase_time": iso(utc_now()),
                    "updated_at": iso(utc_now()),
                    "failure_message": str(err),
                }
            )
        self.store.upsert(record)

    def list_active(self) -> dict[str, Any]:
        records = self.store.list_active()
        return {
            "previews": [self.public_record(record) for record in records],
            "active": len(records),
            "max_concurrent": self.max_concurrent,
        }

    def status(self, preview_id: str) -> dict[str, Any]:
        record = self.store.get(preview_id)
        if not record:
            record = self.record_from_previewctl_state(preview_id)
            if not record:
                raise KeyError(preview_id)
            self.store.upsert(record)
        try:
            current = first_json_object(
                run([sys.executable, str(PREVIEWCTL), "status", preview_id], timeout=60)
            )
            self._merge_controller_status(record, current)
            self.store.upsert(record)
        except Exception as err:
            # A transient status-command failure must not invent a lifecycle state.
            record["failure_message"] = str(err)
            record["updated_at"] = iso(utc_now())
            self.store.upsert(record)
        return self.public_record(record)

    @staticmethod
    def _merge_controller_status(record: dict[str, Any], current: dict[str, Any]) -> None:
        for field in (
            "commit_sha",
            "status",
            "url",
            "initial_url",
            "expires_at",
            "phase",
            "phase_time",
            "ready_at",
            "failure_message",
        ):
            if field in current:
                record[field] = current[field]
        record["updated_at"] = iso(utc_now())

    def destroy(self, preview_id: str) -> dict[str, Any]:
        record = self.store.get(preview_id)
        if not record:
            record = self.record_from_previewctl_state(preview_id)
            if not record:
                raise KeyError(preview_id)
            self.store.upsert(record)
        try:
            run([sys.executable, str(PREVIEWCTL), "destroy", preview_id, "--wait"], timeout=900)
            record.update(
                {
                    "status": "destroyed",
                    "phase": "destroyed",
                    "phase_time": iso(utc_now()),
                    "updated_at": iso(utc_now()),
                    "failure_message": None,
                }
            )
        except Exception as err:
            record.update(
                {
                    "status": "failed",
                    "phase": "failed",
                    "phase_time": iso(utc_now()),
                    "updated_at": iso(utc_now()),
                    "failure_message": str(err),
                }
            )
        self.store.upsert(record)
        return self.public_record(record)

    def cleanup_expired(self) -> None:
        for record in self.store.list_expired():
            try:
                self.destroy(record["id"])
            except Exception:
                continue

    @staticmethod
    def record_from_previewctl_state(preview_id: str) -> dict[str, Any] | None:
        path = PREVIEW_STATE_DIR / f"{preview_id}.json"
        if not path.exists():
            return None
        state = json.loads(path.read_text())
        now = iso(utc_now())
        return {
            "id": state["preview_id"],
            "repo": state.get("repo", "useatrium/atrium"),
            "ref": state.get("ref") or state.get("commit_sha") or "unknown",
            "commit_sha": state.get("commit_sha"),
            "url": state.get("url"),
            "initial_url": state.get("initial_url"),
            "status": state.get("status", "provisioning"),
            "requested_by": None,
            "created_at": state.get("created_at", now),
            "updated_at": now,
            "expires_at": state.get("expires_at", now),
            "failure_message": state.get("failure_message"),
            "phase": state.get("phase"),
            "phase_time": state.get("phase_time"),
            "ready_at": state.get("ready_at"),
        }

    @staticmethod
    def public_record(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "repo": record["repo"],
            "ref": record["ref"],
            "commit_sha": record.get("commit_sha"),
            "status": record["status"],
            "url": record.get("url"),
            "initial_url": record.get("initial_url"),
            "expires_at": record["expires_at"],
            "phase": record.get("phase"),
            "phase_time": record.get("phase_time"),
            "ready_at": record.get("ready_at"),
            "failure_message": record.get("failure_message"),
        }


def make_handler(launcher: Launcher, token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AtriumPreviewLauncher/0.1"

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/healthz":
                return self.send_json({"ok": True})
            if not self.authorized():
                return self.send_error_json(401, "unauthorized")
            if parsed.path == "/previews":
                return self.send_json(launcher.list_active())
            match = re.fullmatch(r"/previews/([^/]+)", parsed.path)
            if match:
                return self.handle_status(match.group(1))
            return self.send_error_json(404, "not_found")

        def do_POST(self) -> None:
            if not self.authorized():
                return self.send_error_json(401, "unauthorized")
            if urlparse(self.path).path != "/previews":
                return self.send_error_json(404, "not_found")
            try:
                return self.send_json(launcher.create(self.read_json()), status=202)
            except CapacityExceeded as err:
                return self.send_error_json(429, "capacity_exceeded", str(err))
            except (ValueError, json.JSONDecodeError) as err:
                return self.send_error_json(400, "bad_request", str(err))
            except Exception as err:
                return self.send_error_json(500, "create_failed", str(err))

        def do_DELETE(self) -> None:
            if not self.authorized():
                return self.send_error_json(401, "unauthorized")
            match = re.fullmatch(r"/previews/([^/]+)", urlparse(self.path).path)
            if not match:
                return self.send_error_json(404, "not_found")
            try:
                return self.send_json(launcher.destroy(match.group(1)))
            except KeyError:
                return self.send_error_json(404, "not_found")

        def handle_status(self, preview_id: str) -> None:
            try:
                self.send_json(launcher.status(preview_id))
            except KeyError:
                self.send_error_json(404, "not_found")

        def authorized(self) -> bool:
            if not token:
                return True
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return False
            return hmac.compare_digest(header.removeprefix("Bearer "), token)

        def read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or "0")
            if length <= 0:
                return {}
            if length > 32_768:
                raise ValueError("request body too large")
            value = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("JSON body must be an object")
            return value

        def send_json(self, body: dict[str, Any], status: int = 200) -> None:
            payload = json.dumps(body, indent=2).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def send_error_json(self, status: int, error: str, message: str | None = None) -> None:
            self.send_json({"error": error, "message": message or error}, status=status)

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"{self.address_string()} - {fmt % args}")

    return Handler


def start_cleanup_thread(launcher: Launcher, interval_seconds: int) -> None:
    if interval_seconds <= 0:
        return

    def loop() -> None:
        while True:
            time.sleep(interval_seconds)
            launcher.cleanup_expired()

    threading.Thread(target=loop, daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(description="Authenticated Atrium OVH preview launcher API")
    parser.add_argument("--host", default=os.environ.get("PREVIEW_LAUNCHER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PREVIEW_LAUNCHER_PORT", "8787")))
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("PREVIEW_LAUNCHER_DB", DEFAULT_DB)))
    parser.add_argument(
        "--token",
        default=os.environ.get(
            "ATRIUM_PREVIEW_LAUNCHER_TOKEN", os.environ.get("PREVIEW_LAUNCHER_TOKEN", "")
        ),
    )
    parser.add_argument(
        "--max-concurrent",
        type=int,
        default=int(os.environ.get("MAX_CONCURRENT_PREVIEWS", str(DEFAULT_MAX_CONCURRENT_PREVIEWS))),
    )
    parser.add_argument(
        "--cleanup-interval-seconds",
        type=int,
        default=int(os.environ.get("PREVIEW_LAUNCHER_CLEANUP_INTERVAL_SECONDS", "300")),
    )
    args = parser.parse_args()

    launcher = Launcher(Store(args.db), max_concurrent=args.max_concurrent)
    start_cleanup_thread(launcher, args.cleanup_interval_seconds)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(launcher, args.token))
    print(f"preview launcher listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
