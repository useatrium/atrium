from typer.testing import CliRunner

from gsuite import client
from gsuite.cli import app

runner = CliRunner()


def test_docs_bullets_command_prints_verification_summary(monkeypatch):
    monkeypatch.setattr(
        client,
        "docs_bullets",
        lambda document_id, match_prefix, bullet_preset, tab_id, dry_run: {
            "document_id": document_id,
            "match_prefix": match_prefix,
            "bullet_preset": bullet_preset,
            "matched_paragraphs": 2,
            "updated_paragraphs": 2,
            "verified_paragraphs": 2,
            "already_bulleted_paragraphs": 1,
            "dry_run": dry_run,
            "paragraphs": [
                {
                    "tab_id": None,
                    "paragraph_index": 1,
                    "before": "- First item",
                    "after": "First item",
                },
                {
                    "tab_id": "tab-2",
                    "paragraph_index": 3,
                    "before": "- Second item",
                    "after": "Second item",
                },
            ],
        },
    )

    result = runner.invoke(app, ["docs", "bullets", "doc-123"])

    assert result.exit_code == 0
    assert "Converted 2 paragraph(s) into Google Docs bullets" in result.output
    assert "Verification: matched 2, updated 2, verified 2, already bulleted 1" in result.output
    assert "paragraph 2:" in result.output
    assert "tab tab-2 paragraph 4:" in result.output
