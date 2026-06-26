"""Workflow: ingest a Muesli meeting transcript into Postgres + Slack notify.

Triggered by the `muesli-push.sh` hook running on each user's Mac after a
meeting completes. The hook fetches the transcript via
``muesli-cli meetings get <id>`` and POSTs the payload to
``/workflows/runs`` with ``workflow_name=muesli_meeting_ingest``.

API keys scoped to ``workflows:muesli_meeting_ingest`` may invoke ONLY this
workflow — they cannot reach any other Centaur surface, so the key is safe to
distribute to laptops.
"""

from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass, field
from typing import Any

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "muesli_meeting_ingest"


@dataclass
class Input:
    meeting_id: int = 0
    host: str = ""
    title: str = ""
    started_at: str | None = None
    ended_at: str | None = None
    duration_seconds: float | None = None
    word_count: int | None = None
    raw_transcript: str = ""
    formatted_notes: str = ""
    notes_state: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    # Optional Slack notification — channel name (e.g. "muesli-transcripts")
    # or channel ID. If omitted, persistence still happens; Slack step is
    # skipped and recorded as such in the checkpoint.
    slack_channel: str | None = None


def _truncate(text: str, limit: int = 2800) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _parse_ts(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        # Accept "...Z" by translating to "+00:00".
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


async def _persist(ctx: WorkflowContext, inp: Input) -> dict[str, Any]:
    if not inp.meeting_id:
        raise ValueError("meeting_id is required")
    row = await ctx._pool.fetchrow(
        """
        INSERT INTO muesli_meetings (
            source, host, meeting_id, title, started_at, ended_at,
            duration_seconds, word_count, raw_transcript, formatted_notes,
            notes_state, metadata, workflow_run_id
        )
        VALUES ('muesli', $1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10, $11::jsonb, $12)
        ON CONFLICT (host, meeting_id) DO UPDATE SET
            title = EXCLUDED.title,
            started_at = EXCLUDED.started_at,
            ended_at = EXCLUDED.ended_at,
            duration_seconds = EXCLUDED.duration_seconds,
            word_count = EXCLUDED.word_count,
            raw_transcript = EXCLUDED.raw_transcript,
            formatted_notes = EXCLUDED.formatted_notes,
            notes_state = EXCLUDED.notes_state,
            metadata = EXCLUDED.metadata,
            workflow_run_id = EXCLUDED.workflow_run_id,
            updated_at = NOW()
        RETURNING id, ingested_at, updated_at
        """,
        inp.host,
        int(inp.meeting_id),
        inp.title or "",
        _parse_ts(inp.started_at),
        _parse_ts(inp.ended_at),
        inp.duration_seconds,
        inp.word_count,
        inp.raw_transcript or "",
        inp.formatted_notes or "",
        inp.notes_state or "",
        json.dumps(inp.metadata or {}),
        ctx.run_id,
    )
    return {
        "row_id": int(row["id"]),
        "ingested_at": row["ingested_at"].isoformat() if row["ingested_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


def _format_slack_message(inp: Input) -> str:
    title = inp.title or "Muesli meeting"
    headline = f"*New transcript:* {title}"
    parts = [headline]
    meta_bits: list[str] = []
    if inp.duration_seconds:
        meta_bits.append(f"⏱ {int(inp.duration_seconds // 60)}m")
    if inp.host:
        meta_bits.append(f"`{inp.host}`")
    if meta_bits:
        parts.append(" · ".join(meta_bits))
    summary = (inp.formatted_notes or inp.raw_transcript or "").strip()
    parts.append(_truncate(summary, 2800) if summary else "_(empty transcript)_")
    return "\n\n".join(parts)


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    persisted = await ctx.step("persist_meeting", lambda: _persist(ctx, inp))

    channel = (inp.slack_channel or "").strip()
    if channel:
        notified = await ctx.post_to_slack(channel, _format_slack_message(inp))
    else:
        notified = {"sent": False, "reason": "no_slack_channel"}

    return {
        "meeting_id": inp.meeting_id,
        "host": inp.host,
        "persisted": persisted,
        "slack": notified,
    }
