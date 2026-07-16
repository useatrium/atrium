"""CLI for Atrium preview environments."""

from __future__ import annotations

import os
import subprocess
import time
from collections.abc import Callable
from typing import Any, NoReturn

import typer
from rich.console import Console
from rich.table import Table

from .client import (
    DEFAULT_LAUNCHER_URL,
    AtriumPreviewClient,
    LauncherHTTPError,
    PreviewError,
)

DEFAULT_REPO = "useatrium/atrium"
DEFAULT_POLL_INTERVAL_SECONDS = 10.0
DEFAULT_TIMEOUT_SECONDS = 15 * 60.0

app = typer.Typer(name="atrium-preview", help="Manage Atrium branch preview environments")
console = Console()
error_console = Console(stderr=True)


def launcher_url() -> str:
    return os.getenv("ATRIUM_PREVIEW_LAUNCHER_URL", DEFAULT_LAUNCHER_URL).rstrip("/")


def positive_float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise PreviewError(f"{name} must be a number, got {raw!r}") from exc
    if value <= 0:
        raise PreviewError(f"{name} must be greater than zero")
    return value


def require_pushed_ref(ref: str) -> None:
    try:
        result = subprocess.run(
            ["git", "ls-remote", "--exit-code", "origin", ref],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise PreviewError("git is required to verify the branch on origin") from exc
    if result.returncode != 0:
        raise PreviewError(
            f"ref {ref!r} was not found on origin; push it first with `git push origin {ref}`"
        )


def value(payload: dict[str, Any], key: str) -> str:
    item = payload.get(key)
    return "-" if item is None or item == "" else str(item)


def print_ready(payload: dict[str, Any]) -> None:
    console.print(f"preview: {value(payload, 'id')}")
    console.print(f"sha: {value(payload, 'commit_sha')}")
    console.print(f"url: {value(payload, 'url')}")
    console.print(f"expires: {value(payload, 'expires_at')}")


def print_status(payload: dict[str, Any]) -> None:
    console.print(f"preview: {value(payload, 'id')}")
    console.print(f"status: {value(payload, 'status')}")
    console.print(f"phase: {value(payload, 'phase')}")
    if payload.get("commit_sha"):
        console.print(f"sha: {payload['commit_sha']}")
    if payload.get("url"):
        console.print(f"url: {payload['url']}")
    if payload.get("expires_at"):
        console.print(f"expires: {payload['expires_at']}")
    if payload.get("failure_message"):
        console.print(f"failure: {payload['failure_message']}")


def render_capacity(client: AtriumPreviewClient, error: LauncherHTTPError) -> None:
    error_console.print(f"error: {error}")
    try:
        payload = client.list()
        previews = payload.get("previews", [])
        if not isinstance(previews, list):
            raise PreviewError("launcher list response had no previews array")

        table = Table(title="Active Atrium previews")
        table.add_column("id")
        table.add_column("ref")
        table.add_column("status")
        table.add_column("expires_at")
        for preview in previews:
            if isinstance(preview, dict):
                table.add_row(
                    value(preview, "id"),
                    value(preview, "ref"),
                    value(preview, "status"),
                    value(preview, "expires_at"),
                )
        error_console.print(table)
    except PreviewError as list_error:
        error_console.print(f"error: could not list active previews: {list_error}")
    error_console.print("Free a slot with: atrium-preview destroy <id>")


def fail(error: PreviewError) -> NoReturn:
    error_console.print(f"error: {error}")
    raise typer.Exit(1)


def with_client(operation: Callable[[AtriumPreviewClient], None]) -> None:
    try:
        with AtriumPreviewClient(base_url=launcher_url()) as client:
            operation(client)
    except PreviewError as exc:
        fail(exc)


@app.command()
def create(
    ref: str = typer.Option(..., "--ref", help="Branch or ref already pushed to origin"),
    repo: str = typer.Option(DEFAULT_REPO, "--repo", help="GitHub repository"),
) -> None:
    """Create a preview and wait until it is ready or failed."""
    if repo != DEFAULT_REPO:
        fail(PreviewError(f"--repo must be {DEFAULT_REPO}"))
    try:
        require_pushed_ref(ref)
    except PreviewError as exc:
        fail(exc)

    def run(client: AtriumPreviewClient) -> None:
        try:
            current = client.create(repo, ref)
        except LauncherHTTPError as exc:
            if exc.status_code == 429:
                render_capacity(client, exc)
                raise typer.Exit(1) from exc
            raise

        preview_id = current.get("id")
        if not isinstance(preview_id, str) or not preview_id:
            raise PreviewError("launcher create response had no preview id")

        interval = positive_float_env(
            "ATRIUM_PREVIEW_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS
        )
        timeout = positive_float_env("ATRIUM_PREVIEW_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
        deadline = time.monotonic() + timeout

        while True:
            status = current.get("status")
            if status == "ready":
                print_ready(current)
                return
            if status == "failed":
                console.print(f"preview: {preview_id}")
                console.print(f"failed phase: {value(current, 'phase')}")
                console.print(f"failure: {value(current, 'failure_message')}")
                raise typer.Exit(1)
            if time.monotonic() >= deadline:
                console.print(f"preview: {preview_id}")
                console.print(f"timed out; current phase: {value(current, 'phase')}")
                console.print(f"continue: atrium-preview status {preview_id}")
                raise typer.Exit(1)

            time.sleep(min(interval, max(0.0, deadline - time.monotonic())))
            current = client.status(preview_id)

    with_client(run)


@app.command()
def status(preview_id: str = typer.Argument(..., help="Preview id")) -> None:
    """Show the current state of a preview."""

    def run(client: AtriumPreviewClient) -> None:
        print_status(client.status(preview_id))

    with_client(run)


@app.command()
def destroy(preview_id: str = typer.Argument(..., help="Preview id")) -> None:
    """Destroy a preview and free its capacity slot."""

    def run(client: AtriumPreviewClient) -> None:
        payload = client.destroy(preview_id)
        console.print(f"preview: {payload.get('id', preview_id)}")
        console.print(f"status: {payload.get('status', 'destroyed')}")

    with_client(run)


if __name__ == "__main__":
    app()
