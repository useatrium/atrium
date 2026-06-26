"""LegiStorm Congressional API client."""


import time
from collections import defaultdict
from typing import Any

import httpx

from centaur_sdk.tool_sdk import secret


class LegiStormClient:
    """Client for LegiStorm Congressional API."""

    BASE_URL = "https://api.legistorm.com/v2.019.10/congress"
    ISSUE_ENDPOINT_CANDIDATES = (
        "/issue_staff/list",
        "/member/issue/list",
        "/office/issue/list",
        "/committee/issue/list",
        "/staff/issue/list",
    )

    def __init__(
        self,
        api_key: str | None = None,
        timeout: float = 60.0,
    ):
        self._api_key = api_key
        self.timeout = timeout
        self._client: httpx.Client | None = None
        self._issue_endpoint: str | None = None
        self._issue_endpoint_checked = False
        self._issue_portfolio_cache: dict[
            tuple[Any, ...],
            tuple[float, tuple[dict[int, list[dict]], dict]],
        ] = {}
        self._issue_portfolio_cache_ttl_s = 3600.0

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _get_api_key(self) -> str:
        api_key = self._api_key or secret("LEGISTORM_API_KEY", "")
        if not api_key:
            raise RuntimeError("LEGISTORM_API_KEY not set.")
        return api_key

    def _request(self, endpoint: str, params: dict | None = None) -> dict:
        """Make an API request."""
        api_key = self._get_api_key()
        url = f"{self.BASE_URL}{endpoint}"

        headers = {
            "X-Api-Key": api_key,
            "Accept": "application/json",
        }

        try:
            response = self.client.get(url, headers=headers, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}") from e
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}") from e

    def raw_request(self, endpoint: str, params: dict | None = None) -> dict | list:
        """Make a raw API request to any LegiStorm Congress endpoint."""
        normalized_endpoint = endpoint if endpoint.startswith("/") else f"/{endpoint}"
        return self._request(normalized_endpoint, params)

    @staticmethod
    def _rows(data: dict | list | None) -> list[dict]:
        if isinstance(data, list):
            return [row for row in data if isinstance(row, dict)]
        if isinstance(data, dict):
            for key in ("data", "results", "items"):
                value = data.get(key)
                if isinstance(value, list):
                    return [row for row in value if isinstance(row, dict)]
        return []

    @staticmethod
    def _current_positions(staff_row: dict) -> list[dict]:
        return [
            position for position in staff_row.get("positions", []) if position.get("is_current")
        ]

    @staticmethod
    def _first_string(*values: object) -> str | None:
        for value in values:
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    @classmethod
    def _extract_staff_id(cls, row: dict) -> int | None:
        candidates = (
            row.get("staff_id"),
            row.get("staffer_id"),
            row.get("person_id"),
            row.get("contact_id"),
            row.get("id"),
            row.get("staff", {}).get("id") if isinstance(row.get("staff"), dict) else None,
            row.get("contact", {}).get("id") if isinstance(row.get("contact"), dict) else None,
        )
        for candidate in candidates:
            if isinstance(candidate, int):
                return candidate
            if isinstance(candidate, str) and candidate.isdigit():
                return int(candidate)
        return None

    @classmethod
    def _extract_member_ids(cls, staff_row: dict) -> set[int]:
        member_ids: set[int] = set()
        for position in cls._current_positions(staff_row):
            member = position.get("member")
            if isinstance(member, dict) and isinstance(member.get("member_id"), int):
                member_ids.add(member["member_id"])
        for address in staff_row.get("office_member_addresses", []):
            member = address.get("member")
            if isinstance(member, dict) and isinstance(member.get("member_id"), int):
                member_ids.add(member["member_id"])
        return member_ids

    @classmethod
    def _extract_office_ids(cls, staff_row: dict) -> set[int]:
        office_ids: set[int] = set()
        for position in cls._current_positions(staff_row):
            office = position.get("office")
            if isinstance(office, dict) and isinstance(office.get("office_id"), int):
                office_ids.add(office["office_id"])
        for address in staff_row.get("office_member_addresses", []):
            office = address.get("office")
            if isinstance(office, dict) and isinstance(office.get("office_id"), int):
                office_ids.add(office["office_id"])
        return office_ids

    @classmethod
    def _issue_name_from_row(cls, row: dict) -> str | None:
        nested_issue = row.get("issue")
        if isinstance(nested_issue, dict):
            return cls._first_string(
                nested_issue.get("name"),
                nested_issue.get("issue_name"),
                nested_issue.get("display_name"),
                nested_issue.get("title"),
            )
        return cls._first_string(
            row.get("issue_name"),
            row.get("issue"),
            row.get("legislative_issue"),
            row.get("issue_title"),
            row.get("name"),
            row.get("title"),
            row.get("subject"),
        )

    @classmethod
    def _portfolio_kind_from_row(cls, row: dict) -> str:
        lower_keys = {str(key).lower() for key in row}
        if any("caucus" in key for key in lower_keys):
            return "caucus_contact"
        return "issue"

    @classmethod
    def _normalize_issue_portfolios(cls, data: dict | list) -> dict[int, list[dict]]:
        portfolios_by_staff: dict[int, list[dict]] = defaultdict(list)

        def add_portfolio(staff_id: int | None, name: str | None, kind: str) -> None:
            if not staff_id or not name:
                return
            portfolio = {"name": name, "kind": kind}
            if portfolio not in portfolios_by_staff[staff_id]:
                portfolios_by_staff[staff_id].append(portfolio)

        for row in cls._rows(data):
            staff_id = cls._extract_staff_id(row)
            embedded_keys = (
                "issues",
                "legislative_issues",
                "issue_portfolios",
                "issue_assignments",
            )
            embedded_seen = False
            for key in embedded_keys:
                embedded = row.get(key)
                if not isinstance(embedded, list):
                    continue
                embedded_seen = True
                for item in embedded:
                    if isinstance(item, dict):
                        add_portfolio(
                            staff_id,
                            cls._issue_name_from_row(item),
                            cls._portfolio_kind_from_row(item),
                        )
                    elif isinstance(item, str):
                        add_portfolio(staff_id, item, "issue")
            if embedded_seen:
                continue
            add_portfolio(
                staff_id, cls._issue_name_from_row(row), cls._portfolio_kind_from_row(row)
            )

        return portfolios_by_staff

    @classmethod
    def _looks_like_issue_assignments(cls, data: dict | list) -> bool:
        portfolios_by_staff = cls._normalize_issue_portfolios(data)
        return any(portfolios_by_staff.values())

    @staticmethod
    def _normalize_endpoint(endpoint: str) -> str:
        return endpoint if endpoint.startswith("/") else f"/{endpoint}"

    def _candidate_issue_endpoints(self, issue_endpoint: str | None = None) -> list[str]:
        explicit = issue_endpoint or secret("LEGISTORM_ISSUES_ENDPOINT", "")
        candidates: list[str] = []
        if explicit:
            candidates.append(self._normalize_endpoint(explicit))
        if self._issue_endpoint:
            candidates.append(self._issue_endpoint)
        for candidate in self.ISSUE_ENDPOINT_CANDIDATES:
            if candidate not in candidates:
                candidates.append(candidate)
        return candidates

    def _issue_scope_queries(
        self,
        staff_rows: list[dict],
        updated_from: str,
        updated_to: str,
        limit: int,
        page: int,
    ) -> list[dict]:
        member_ids = sorted(
            {member_id for row in staff_rows for member_id in self._extract_member_ids(row)}
        )
        office_ids = sorted(
            {office_id for row in staff_rows for office_id in self._extract_office_ids(row)}
        )
        staff_ids = sorted(
            {
                staff_id
                for row in staff_rows
                for staff_id in [self._extract_staff_id(row)]
                if isinstance(staff_id, int)
            }
        )

        queries: list[dict] = []
        for member_id in member_ids:
            queries.append(
                {
                    "kind": "member",
                    "params": {
                        "updated_from": updated_from,
                        "updated_to": updated_to,
                        "limit": min(limit, 1000),
                        "page": page,
                        "member_id": member_id,
                    },
                }
            )
        for office_id in office_ids:
            queries.append(
                {
                    "kind": "office",
                    "params": {
                        "updated_from": updated_from,
                        "updated_to": updated_to,
                        "limit": min(limit, 1000),
                        "page": page,
                        "office_id": office_id,
                    },
                }
            )
        for staff_id in staff_ids:
            queries.append(
                {
                    "kind": "staff",
                    "params": {
                        "updated_from": updated_from,
                        "updated_to": updated_to,
                        "limit": min(limit, 1000),
                        "page": page,
                        "staff_id": staff_id,
                    },
                }
            )
        return queries

    def _fetch_issue_portfolios(
        self,
        staff_rows: list[dict],
        updated_from: str,
        updated_to: str,
        limit: int,
        page: int,
        issue_endpoint: str | None = None,
    ) -> tuple[dict[int, list[dict]], dict]:
        cache_key = (
            tuple(
                sorted(
                    {
                        (
                            self._extract_staff_id(row),
                            tuple(sorted(self._extract_member_ids(row))),
                            tuple(sorted(self._extract_office_ids(row))),
                        )
                        for row in staff_rows
                    }
                )
            ),
            updated_from,
            updated_to,
            int(limit),
            int(page),
            self._normalize_endpoint(issue_endpoint) if issue_endpoint else None,
        )
        cached = self._issue_portfolio_cache.get(cache_key)
        now = time.monotonic()
        if cached and now - cached[0] < self._issue_portfolio_cache_ttl_s:
            portfolios, metadata = cached[1]
            cached_metadata = dict(metadata)
            cached_metadata["issue_portfolio_cache"] = "hit"
            return portfolios, cached_metadata

        queries = self._issue_scope_queries(staff_rows, updated_from, updated_to, limit, page)
        if not queries:
            return {}, {
                "issue_endpoint": None,
                "issue_portfolios_available": False,
                "issue_portfolio_status": "no_supported_scope",
                "issue_portfolio_cache": "skipped",
            }

        candidates = self._candidate_issue_endpoints(issue_endpoint)
        if self._issue_endpoint_checked and not issue_endpoint and self._issue_endpoint is None:
            return {}, {
                "issue_endpoint": None,
                "issue_portfolios_available": False,
                "issue_portfolio_status": "no_issue_endpoint_discovered",
                "issue_portfolio_cache": "skipped",
            }

        for endpoint in candidates:
            for query in queries:
                try:
                    data = self._request(endpoint, query["params"])
                except RuntimeError:
                    continue
                if not self._looks_like_issue_assignments(data):
                    continue
                self._issue_endpoint = endpoint
                self._issue_endpoint_checked = True
                result = (
                    self._normalize_issue_portfolios(data),
                    {
                        "issue_endpoint": endpoint,
                        "issue_portfolios_available": True,
                        "issue_portfolio_status": f"ok:{query['kind']}",
                        "issue_portfolio_cache": "miss",
                    },
                )
                self._issue_portfolio_cache[cache_key] = (now, result)
                return result

        if not issue_endpoint:
            self._issue_endpoint_checked = True
            self._issue_endpoint = None
        return {}, {
            "issue_endpoint": self._normalize_endpoint(issue_endpoint) if issue_endpoint else None,
            "issue_portfolios_available": False,
            "issue_portfolio_status": "no_issue_endpoint_discovered",
            "issue_portfolio_cache": "miss",
        }

    @classmethod
    def _staff_with_issue_portfolios(
        cls,
        staff_rows: list[dict],
        portfolios_by_staff: dict[int, list[dict]],
    ) -> list[dict]:
        enriched_rows: list[dict] = []
        for staff_row in staff_rows:
            staff_id = cls._extract_staff_id(staff_row)
            issue_portfolios = list(portfolios_by_staff.get(staff_id, []))
            enriched_row = dict(staff_row)
            enriched_row["issue_portfolios"] = issue_portfolios
            enriched_row["issues"] = [
                item["name"] for item in issue_portfolios if item["kind"] == "issue"
            ]
            enriched_row["caucus_contacts"] = [
                item["name"] for item in issue_portfolios if item["kind"] == "caucus_contact"
            ]
            enriched_rows.append(enriched_row)
        return enriched_rows

    def get_members(
        self,
        updated_from: str,
        updated_to: str,
        limit: int = 20,
        page: int = 1,
        member_id: int | None = None,
        state_id: str | None = None,
        status: str = "a",
    ) -> dict:
        """Get congressional members.

        Args:
            updated_from: YYYY-MM-DD - entities updated after this date
            updated_to: YYYY-MM-DD - entities updated before this date
            limit: Max results (up to 1000)
            page: Page number
            member_id: Specific member ID
            state_id: State postal abbreviation (e.g., CA, NY)
            status: a=all, c=current, i=incoming, d=departing
        """
        params = {
            "updated_from": updated_from,
            "updated_to": updated_to,
            "limit": min(limit, 1000),
            "page": page,
            "status": status,
        }
        if member_id:
            params["id"] = member_id
        if state_id:
            params["state_id"] = state_id

        return self._request("/member/list", params)

    def get_staff(
        self,
        updated_from: str,
        updated_to: str,
        limit: int = 20,
        page: int = 1,
        staff_id: int | None = None,
        member_id: int | None = None,
        office_id: int | None = None,
    ) -> dict:
        """Get congressional staff.

        Args:
            updated_from: YYYY-MM-DD
            updated_to: YYYY-MM-DD
            limit: Max results (up to 1000)
            page: Page number
            staff_id: Specific staff ID
            member_id: Staff for a specific member
            office_id: Staff for a specific office
        """
        params = {
            "updated_from": updated_from,
            "updated_to": updated_to,
            "limit": min(limit, 1000),
            "page": page,
        }
        if staff_id:
            params["id"] = staff_id
        if member_id:
            params["member_id"] = member_id
        if office_id:
            params["office_id"] = office_id

        return self._request("/staff/list", params)

    def get_staff_with_issue_portfolios(
        self,
        updated_from: str,
        updated_to: str,
        limit: int = 20,
        page: int = 1,
        staff_id: int | None = None,
        member_id: int | None = None,
        office_id: int | None = None,
        issue_endpoint: str | None = None,
    ) -> dict:
        """Get staff records enriched with explicit issue portfolios when available.

        LegiStorm's public product exposes issue portfolios, but not every API key or API
        route includes those assignments. This method tries the current staff list endpoint
        first, then enriches the rows through a small set of candidate issue-assignment
        routes. When no issue route is available, it returns the staff rows with empty
        `issue_portfolios` so callers can distinguish "no data available" from "no staff."

        Args:
            updated_from: YYYY-MM-DD
            updated_to: YYYY-MM-DD
            limit: Max results (up to 1000)
            page: Page number
            staff_id: Specific staff ID
            member_id: Staff for a specific member
            office_id: Staff for a specific office
            issue_endpoint: Optional explicit issue endpoint override. If unset, the client
                also checks LEGISTORM_ISSUES_ENDPOINT before trying known candidates.
        """
        staff_rows = self._rows(
            self.get_staff(
                updated_from=updated_from,
                updated_to=updated_to,
                limit=limit,
                page=page,
                staff_id=staff_id,
                member_id=member_id,
                office_id=office_id,
            )
        )
        portfolios_by_staff, metadata = self._fetch_issue_portfolios(
            staff_rows=staff_rows,
            updated_from=updated_from,
            updated_to=updated_to,
            limit=limit,
            page=page,
            issue_endpoint=issue_endpoint,
        )
        return {
            **metadata,
            "staff": self._staff_with_issue_portfolios(staff_rows, portfolios_by_staff),
        }

    def get_staff_retired_ids(self) -> dict:
        """Get IDs of staff no longer employed by Congress."""
        return self._request("/staff/retired-ids")

    def get_offices(
        self,
        updated_from: str,
        updated_to: str,
        limit: int = 20,
        page: int = 1,
        office_id: int | None = None,
    ) -> dict:
        """Get offices (committees, subcommittees, commissions, admin offices).

        Args:
            updated_from: YYYY-MM-DD
            updated_to: YYYY-MM-DD
            limit: Max results (up to 1000)
            page: Page number
            office_id: Specific office ID
        """
        params = {
            "updated_from": updated_from,
            "updated_to": updated_to,
            "limit": min(limit, 1000),
            "page": page,
        }
        if office_id:
            params["id"] = office_id

        return self._request("/office/list", params)

    def get_offices_retired_ids(self) -> dict:
        """Get IDs of inactive offices."""
        return self._request("/office/retired-ids")

    def get_caucuses(
        self,
        updated_from: str,
        updated_to: str,
        limit: int = 20,
        page: int = 1,
        caucus_id: int | None = None,
    ) -> dict:
        """Get congressional caucuses (requires caucus subscription).

        Args:
            updated_from: YYYY-MM-DD
            updated_to: YYYY-MM-DD
            limit: Max results (up to 1000)
            page: Page number
            caucus_id: Specific caucus ID
        """
        params = {
            "updated_from": updated_from,
            "updated_to": updated_to,
            "limit": min(limit, 1000),
            "page": page,
        }
        if caucus_id:
            params["id"] = caucus_id

        return self._request("/caucus/list", params)

    def get_caucuses_retired_ids(self) -> dict:
        """Get IDs of inactive/deleted caucuses."""
        return self._request("/caucus/retired-ids")

    def get_townhalls(
        self,
        updated_from: str,
        updated_to: str,
        limit: int = 20,
        page: int = 1,
        townhall_id: int | None = None,
    ) -> dict:
        """Get town hall events.

        Args:
            updated_from: YYYY-MM-DD
            updated_to: YYYY-MM-DD
            limit: Max results (up to 100)
            page: Page number
            townhall_id: Specific town hall ID
        """
        params = {
            "updated_from": updated_from,
            "updated_to": updated_to,
            "limit": min(limit, 100),
            "page": page,
        }
        if townhall_id:
            params["id"] = townhall_id

        return self._request("/townhall/list", params)

    def get_trips(
        self,
        updated_from: str,
        updated_to: str,
        limit: int = 20,
        page: int = 1,
        trip_id: int | None = None,
    ) -> dict:
        """Get privately funded travel.

        Args:
            updated_from: YYYY-MM-DD
            updated_to: YYYY-MM-DD
            limit: Max results (up to 100)
            page: Page number
            trip_id: Specific trip ID
        """
        params = {
            "updated_from": updated_from,
            "updated_to": updated_to,
            "limit": min(limit, 100),
            "page": page,
        }
        if trip_id:
            params["id"] = trip_id

        return self._request("/trips/list", params)

    def get_hearings(
        self,
        updated_from: str,
        updated_to: str,
        chamber: str = "H",
        limit: int = 20,
        page: int = 1,
        hearing_id: int | None = None,
        office_id: int | None = None,
        hearing_date_from: str | None = None,
        hearing_date_to: str | None = None,
    ) -> dict:
        """Get congressional hearings.

        Args:
            updated_from: YYYY-MM-DD
            updated_to: YYYY-MM-DD
            chamber: H=House, S=Senate
            limit: Max results (up to 100)
            page: Page number
            hearing_id: Specific hearing ID
            office_id: Filter by committee/office
            hearing_date_from: YYYY-MM-DD filter by hearing date
            hearing_date_to: YYYY-MM-DD filter by hearing date
        """
        params = {
            "updated_from": updated_from,
            "updated_to": updated_to,
            "chamber": chamber,
            "limit": min(limit, 100),
            "page": page,
        }
        if hearing_id:
            params["id"] = hearing_id
        if office_id:
            params["office_id"] = office_id
        if hearing_date_from:
            params["hearing_date_from"] = hearing_date_from
        if hearing_date_to:
            params["hearing_date_to"] = hearing_date_to

        return self._request("/hearings/list", params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> LegiStormClient:
    return LegiStormClient()
