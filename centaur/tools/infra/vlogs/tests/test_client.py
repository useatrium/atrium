from __future__ import annotations

from vlogs.client import _field_expr, _quote_logsql_value


def test_quote_logsql_value_handles_slack_thread_key() -> None:
    assert (
        _field_expr("thread_key", "C0AJ07U8Z1N:1777910337.403889")
        == 'thread_key:"C0AJ07U8Z1N:1777910337.403889"'
    )


def test_quote_logsql_value_escapes_quotes_and_backslashes() -> None:
    assert _quote_logsql_value('a"b\\c') == '"a\\"b\\\\c"'
