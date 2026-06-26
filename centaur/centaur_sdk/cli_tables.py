"""Table rendering helpers for tool CLIs."""

from __future__ import annotations

from rich.table import Table as RichTable

Table = RichTable


def render_text_table(headers: list[str], rows: list[list[str]]) -> str:
    """Render a plain-text table with padded columns.

    Useful for CLIs that should avoid hardcoding one-off spacing logic.
    """
    if not headers:
        return ""
    if not rows:
        return "No rows."

    widths = [len(header) for header in headers]
    for row in rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(cell))

    def _format(row: list[str]) -> str:
        return "  ".join(cell.ljust(widths[idx]) for idx, cell in enumerate(row))

    lines = [_format(headers), "  ".join("-" * width for width in widths)]
    lines.extend(_format(row) for row in rows)
    return "\n".join(lines)
