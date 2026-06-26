from __future__ import annotations

from legistorm.client import LegiStormClient


def test_issue_portfolios_are_cached_per_staff_scope() -> None:
    client = LegiStormClient(api_key="test")
    calls: list[tuple[str, dict | None]] = []

    def fake_request(endpoint: str, params: dict | None = None):
        calls.append((endpoint, params))
        return {
            "data": [
                {
                    "staff_id": 123,
                    "issues": [{"issue_name": "Digital Assets"}],
                }
            ]
        }

    client._request = fake_request  # type: ignore[method-assign]
    staff_rows = [{"staff_id": 123}]

    first, first_meta = client._fetch_issue_portfolios(
        staff_rows,
        updated_from="2026-01-01",
        updated_to="2026-01-02",
        limit=20,
        page=1,
        issue_endpoint="/issue_staff/list",
    )
    second, second_meta = client._fetch_issue_portfolios(
        staff_rows,
        updated_from="2026-01-01",
        updated_to="2026-01-02",
        limit=20,
        page=1,
        issue_endpoint="/issue_staff/list",
    )

    assert calls == [
        (
            "/issue_staff/list",
            {
                "updated_from": "2026-01-01",
                "updated_to": "2026-01-02",
                "limit": 20,
                "page": 1,
                "staff_id": 123,
            },
        )
    ]
    assert first == second == {123: [{"kind": "issue", "name": "Digital Assets"}]}
    assert first_meta["issue_portfolio_cache"] == "miss"
    assert second_meta["issue_portfolio_cache"] == "hit"


def test_issue_portfolio_cache_key_includes_member_scope() -> None:
    client = LegiStormClient(api_key="test")
    calls: list[dict | None] = []

    def fake_request(endpoint: str, params: dict | None = None):
        calls.append(params)
        issue = f"Member {params.get('member_id')}" if params else "Unknown"
        return {
            "data": [
                {
                    "staff_id": 123,
                    "issues": [{"issue_name": issue}],
                }
            ]
        }

    client._request = fake_request  # type: ignore[method-assign]
    first_rows = [
        {"staff_id": 123, "positions": [{"is_current": True, "member": {"member_id": 1}}]}
    ]
    second_rows = [
        {"staff_id": 123, "positions": [{"is_current": True, "member": {"member_id": 2}}]}
    ]

    first, _ = client._fetch_issue_portfolios(first_rows, "2026-01-01", "2026-01-02", 20, 1)
    second, _ = client._fetch_issue_portfolios(second_rows, "2026-01-01", "2026-01-02", 20, 1)

    assert len(calls) == 2
    assert first != second
