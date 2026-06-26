"""CLI for Airtable."""

import json

import typer
from dotenv import load_dotenv
from rich.console import Console

from .client import AirtableClient

load_dotenv()

app = typer.Typer(name="airtable", help="Airtable API client")
console = Console()


def _print(data: object) -> None:
    console.print_json(json.dumps(data, default=str))


@app.command()
def bases(limit: int = typer.Option(100, "--limit", "-n")) -> None:
    """List visible Airtable bases."""
    _print(AirtableClient().list_bases(limit=limit))


@app.command()
def schema(base_id: str) -> None:
    """Get a base schema."""
    _print(AirtableClient().schema(base_id))


@app.command()
def records(
    base_id: str,
    table: str,
    view: str | None = typer.Option(None, "--view"),
    max_records: int = typer.Option(100, "--max-records", "-n"),
) -> None:
    """List records from a table or view."""
    _print(AirtableClient().list_records(base_id, table, view=view, max_records=max_records))


@app.command()
def from_url(url: str, max_records: int = typer.Option(50, "--max-records", "-n")) -> None:
    """Read a compact snapshot from an Airtable table/view URL."""
    _print(AirtableClient().snapshot_from_url(url, max_records=max_records))


if __name__ == "__main__":
    app()
