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
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
PREVIEWCTL = ROOT / "deploy" / "preview" / "aws" / "previewctl.py"
DEFAULT_DB = ROOT / "deploy" / "preview" / "aws" / ".state" / "launcher.sqlite3"
PREVIEW_STATE_DIR = ROOT / "deploy" / "preview" / "aws" / ".state"
DEFAULT_PROFILE = "atrium-preview"
DEFAULT_REGION = "us-east-1"
DEFAULT_TTL_HOURS = 24
MAX_TTL_HOURS = 72
ALLOWED_REPOS = {"useatrium/atrium"}


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
    if repo != "useatrium/atrium":
        raise ValueError(f"repo is not allowed: {repo}")
    if re.fullmatch(r"[0-9a-f]{40}", ref):
        run(["git", "fetch", "--quiet", "origin", ref], timeout=120)
        return resolve_commit(ref)

    branch = ref.removeprefix("refs/heads/")
    remote_ref = f"refs/remotes/origin/{branch}"
    run(
        ["git", "fetch", "--quiet", "origin", f"refs/heads/{branch}:{remote_ref}"],
        timeout=120,
    )
    return resolve_commit(remote_ref)


def preview_health_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url.rstrip('/')}/healthz", timeout=3) as res:
            return 200 <= res.status < 300
    except Exception:
        return False


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
                return json.loads(text[start : index + 1])
    raise ValueError("command output contained incomplete JSON")


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.init()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        with self.connect() as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS previews (
                  id TEXT PRIMARY KEY,
                  repo TEXT NOT NULL,
                  ref TEXT NOT NULL,
                  commit_sha TEXT,
                  url TEXT,
                  status TEXT NOT NULL,
                  requested_by TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  failure_message TEXT
                )
                """
            )

    def upsert(self, preview: dict[str, Any]) -> None:
        fields = {
            "id": preview["id"],
            "repo": preview["repo"],
            "ref": preview["ref"],
            "commit_sha": preview.get("commit_sha"),
            "url": preview.get("url"),
            "status": preview["status"],
            "requested_by": preview.get("requested_by"),
            "created_at": preview["created_at"],
            "updated_at": preview["updated_at"],
            "expires_at": preview["expires_at"],
            "failure_message": preview.get("failure_message"),
        }
        with self.lock, self.connect() as db:
            db.execute(
                """
                INSERT INTO previews
                  (id, repo, ref, commit_sha, url, status, requested_by, created_at, updated_at, expires_at, failure_message)
                VALUES
                  (:id, :repo, :ref, :commit_sha, :url, :status, :requested_by, :created_at, :updated_at, :expires_at, :failure_message)
                ON CONFLICT(id) DO UPDATE SET
                  repo=excluded.repo,
                  ref=excluded.ref,
                  commit_sha=excluded.commit_sha,
                  url=excluded.url,
                  status=excluded.status,
                  requested_by=excluded.requested_by,
                  updated_at=excluded.updated_at,
                  expires_at=excluded.expires_at,
                  failure_message=excluded.failure_message
                """,
                fields,
            )

    def get(self, preview_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM previews WHERE id = ?", (preview_id,)).fetchone()
        return dict(row) if row else None

    def list_expired(self) -> list[dict[str, Any]]:
        now = iso(utc_now())
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT * FROM previews
                 WHERE expires_at <= ?
                   AND status NOT IN ('destroying', 'destroyed', 'expired')
                """,
                (now,),
            ).fetchall()
        return [dict(row) for row in rows]


class Launcher:
    def __init__(self, store: Store, profile: str, region: str):
        self.store = store
        self.profile = profile
        self.region = region

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        repo = str(body.get("repo") or "useatrium/atrium")
        ref = str(body.get("ref") or body.get("branch") or body.get("commit_sha") or "").strip()
        if not ref:
            raise ValueError("ref, branch, or commit_sha is required")
        if repo not in ALLOWED_REPOS:
            raise ValueError(f"repo is not allowed: {repo}")
        ttl_hours = int(body["ttl_hours"]) if "ttl_hours" in body else DEFAULT_TTL_HOURS
        if ttl_hours <= 0 or ttl_hours > MAX_TTL_HOURS:
            raise ValueError(f"ttl_hours must be between 1 and {MAX_TTL_HOURS}")
        if body.get("commit_sha"):
            commit_sha = str(body["commit_sha"])
        elif body.get("fetch", True):
            commit_sha = fetch_and_resolve_commit(repo, ref)
        else:
            commit_sha = resolve_commit(ref)
        expires_at = utc_now() + dt.timedelta(hours=ttl_hours)
        requested_by = body.get("requested_by")

        cmd = [
            sys.executable,
            str(PREVIEWCTL),
            "--profile",
            self.profile,
            "--region",
            self.region,
            "create",
            commit_sha,
            "--ttl-hours",
            str(ttl_hours),
        ]
        output = run(cmd, timeout=300)
        created = first_json_object(output)
        preview_id = created["preview_id"]
        record = {
            "id": preview_id,
            "repo": repo,
            "ref": ref,
            "commit_sha": commit_sha,
            "url": None,
            "status": "creating",
            "requested_by": requested_by,
            "created_at": iso(utc_now()),
            "updated_at": iso(utc_now()),
            "expires_at": created.get("expires_at") or iso(expires_at),
            "failure_message": None,
        }
        self.store.upsert(record)
        return self.status(preview_id)

    def status(self, preview_id: str) -> dict[str, Any]:
        record = self.store.get(preview_id)
        if not record:
            record = self.record_from_previewctl_state(preview_id)
            if not record:
                raise KeyError(preview_id)
            self.store.upsert(record)
        try:
            output = run(
                [sys.executable, str(PREVIEWCTL), "--profile", self.profile, "--region", self.region, "status", preview_id],
                timeout=60,
            )
            current = first_json_object(output)
            status = current.get("instance_state") or record["status"]
            if status == "running" and current.get("url"):
                if current.get("appliance_ready") and preview_health_ok(current["url"]):
                    status = "ready"
                elif current.get("phase"):
                    status = f"bootstrapping:{current['phase']}"
                else:
                    status = "running"
            record.update(
                {
                    "status": status,
                    "url": current.get("url"),
                    "commit_sha": current.get("commit_sha") or record.get("commit_sha"),
                    "phase": current.get("phase"),
                    "phase_time": current.get("phase_time"),
                    "appliance_ready": current.get("appliance_ready"),
                    "ready_at": current.get("ready_at"),
                    "updated_at": iso(utc_now()),
                    "failure_message": None,
                }
            )
            self.store.upsert(record)
        except Exception as err:
            record.update({"status": "unknown", "updated_at": iso(utc_now()), "failure_message": str(err)})
            self.store.upsert(record)
        return self.public_record(record)

    def destroy(self, preview_id: str) -> dict[str, Any]:
        record = self.store.get(preview_id)
        if not record:
            record = self.record_from_previewctl_state(preview_id)
            if not record:
                raise KeyError(preview_id)
            self.store.upsert(record)
        record.update({"status": "destroying", "updated_at": iso(utc_now()), "failure_message": None})
        self.store.upsert(record)
        try:
            run(
                [
                    sys.executable,
                    str(PREVIEWCTL),
                    "--profile",
                    self.profile,
                    "--region",
                    self.region,
                    "destroy",
                    preview_id,
                    "--wait",
                ],
                timeout=600,
            )
            record.update({"status": "destroyed", "updated_at": iso(utc_now())})
        except Exception as err:
            record.update({"status": "failed", "updated_at": iso(utc_now()), "failure_message": str(err)})
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
            "repo": "useatrium/atrium",
            "ref": state.get("commit_sha") or "unknown",
            "commit_sha": state.get("commit_sha"),
            "url": None,
            "status": state.get("status") or "unknown",
            "requested_by": None,
            "created_at": state.get("created_at") or now,
            "updated_at": now,
            "expires_at": state.get("expires_at") or now,
            "failure_message": None,
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
            "requested_by": record.get("requested_by"),
            "created_at": record["created_at"],
            "updated_at": record["updated_at"],
            "expires_at": record["expires_at"],
            "failure_message": record.get("failure_message"),
            "phase": record.get("phase"),
            "phase_time": record.get("phase_time"),
            "appliance_ready": record.get("appliance_ready"),
            "ready_at": record.get("ready_at"),
        }


def make_handler(launcher: Launcher, token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AtriumPreviewLauncher/0.1"

        def do_GET(self) -> None:
            if not self.authorized():
                return self.send_error_json(401, "unauthorized")
            parsed = urlparse(self.path)
            if parsed.path == "/healthz":
                return self.send_json({"ok": True})
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
                return self.send_json(launcher.create(self.read_json()), status=201)
            except ValueError as err:
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
            prefix = "Bearer "
            if not header.startswith(prefix):
                return False
            return hmac.compare_digest(header.removeprefix(prefix), token)

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
    parser = argparse.ArgumentParser(description="Authenticated Atrium AWS preview launcher API")
    parser.add_argument("--host", default=os.environ.get("PREVIEW_LAUNCHER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PREVIEW_LAUNCHER_PORT", "8787")))
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("PREVIEW_LAUNCHER_DB", DEFAULT_DB)))
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE", DEFAULT_PROFILE))
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", DEFAULT_REGION))
    parser.add_argument("--token", default=os.environ.get("PREVIEW_LAUNCHER_TOKEN", ""))
    parser.add_argument(
        "--cleanup-interval-seconds",
        type=int,
        default=int(os.environ.get("PREVIEW_LAUNCHER_CLEANUP_INTERVAL_SECONDS", "300")),
    )
    args = parser.parse_args()

    launcher = Launcher(Store(args.db), profile=args.profile, region=args.region)
    start_cleanup_thread(launcher, args.cleanup_interval_seconds)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(launcher, args.token))
    print(f"preview launcher listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
