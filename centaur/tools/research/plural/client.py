"""Plural (Open States) API v3 client — state legislation, legislators, committees, and events."""

import httpx
from centaur_sdk.tool_sdk import secret


class PluralClient:
    """Client for the Plural / Open States API v3."""

    BASE_URL = "https://v3.openstates.org"

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.timeout = timeout
        self._http: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._http is None:
            self._http = httpx.Client(timeout=self.timeout)
        return self._http

    def _get_api_key(self) -> str:
        api_key = self._api_key or secret("PLURAL_API_KEY", "")
        if not api_key:
            raise RuntimeError("PLURAL_API_KEY not set.")
        return api_key

    def _request(self, endpoint: str, params: dict | None = None) -> dict | list:
        url = f"{self.BASE_URL}{endpoint}"
        headers = {"X-API-KEY": self._get_api_key()}
        if params:
            params = {k: v for k, v in params.items() if v is not None}
        try:
            response = self.client.get(url, params=params, headers=headers)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    # ── Jurisdictions ──────────────────────────────────────────────

    def list_jurisdictions(
        self,
        classification: str | None = None,
        include: str | None = None,
        page: int = 1,
        per_page: int = 52,
    ) -> dict:
        """List available jurisdictions (states, territories, municipalities).

        Args:
            classification: Filter by type (state, municipality)
            include: Comma-separated includes (organizations, legislative_sessions, latest_runs)
            page: Page number
            per_page: Results per page
        """
        params: dict = {"page": page, "per_page": per_page}
        if classification:
            params["classification"] = classification
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request("/jurisdictions", params)

    def get_jurisdiction(
        self,
        jurisdiction_id: str,
        include: str | None = None,
    ) -> dict:
        """Get details for a single jurisdiction.

        Args:
            jurisdiction_id: Jurisdiction name or OCD ID (e.g. 'ocd-jurisdiction/country:us/state:ca/government')
            include: Comma-separated includes (organizations, legislative_sessions, latest_runs)
        """
        params: dict = {}
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request(f"/jurisdictions/{jurisdiction_id}", params)

    # ── People (Legislators) ──────────────────────────────────────

    def search_people(
        self,
        jurisdiction: str | None = None,
        name: str | None = None,
        org_classification: str | None = None,
        district: str | None = None,
        include: str | None = None,
        page: int = 1,
        per_page: int = 10,
    ) -> dict:
        """Search for legislators, governors, etc.

        Must provide either jurisdiction or name.

        Args:
            jurisdiction: State name or OCD ID (e.g. 'California' or 'ca')
            name: Filter by name (case-insensitive)
            org_classification: Filter by role (upper, lower, legislature, executive)
            district: Filter by district name
            include: Comma-separated includes (other_names, other_identifiers, links, sources, offices)
            page: Page number
            per_page: Results per page
        """
        params: dict = {"page": page, "per_page": per_page}
        if jurisdiction:
            params["jurisdiction"] = jurisdiction
        if name:
            params["name"] = name
        if org_classification:
            params["org_classification"] = org_classification
        if district:
            params["district"] = district
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request("/people", params)

    def people_by_location(
        self,
        lat: float,
        lng: float,
        include: str | None = None,
    ) -> dict:
        """Get legislators for a given lat/lng location.

        Args:
            lat: Latitude
            lng: Longitude
            include: Comma-separated includes (other_names, other_identifiers, links, sources, offices)
        """
        params: dict = {"lat": lat, "lng": lng}
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request("/people.geo", params)

    # ── Bills ─────────────────────────────────────────────────────

    def search_bills(
        self,
        jurisdiction: str | None = None,
        session: str | None = None,
        chamber: str | None = None,
        classification: str | None = None,
        subject: str | None = None,
        q: str | None = None,
        sponsor: str | None = None,
        updated_since: str | None = None,
        created_since: str | None = None,
        action_since: str | None = None,
        sort: str = "updated_desc",
        include: str | None = None,
        page: int = 1,
        per_page: int = 10,
    ) -> dict:
        """Search bills by various criteria.

        Args:
            jurisdiction: State name or OCD ID
            session: Session identifier
            chamber: Chamber of origination (upper, lower)
            classification: Bill classification (bill, resolution, etc.)
            subject: Filter by subject
            q: Full text search query
            sponsor: Filter by sponsor name or person ID
            updated_since: ISO date for bills updated since
            created_since: ISO date for bills created since
            action_since: ISO date for bills with action since
            sort: Sort order (updated_desc, updated_asc, first_action_desc, first_action_asc, latest_action_desc, latest_action_asc)
            include: Comma-separated includes (sponsorships, abstracts, other_titles, other_identifiers, actions, sources, documents, versions, votes, related_bills)
            page: Page number
            per_page: Results per page
        """
        params: dict = {"page": page, "per_page": per_page, "sort": sort}
        if jurisdiction:
            params["jurisdiction"] = jurisdiction
        if session:
            params["session"] = session
        if chamber:
            params["chamber"] = chamber
        if classification:
            params["classification"] = classification
        if subject:
            params["subject"] = subject
        if q:
            params["q"] = q
        if sponsor:
            params["sponsor"] = sponsor
        if updated_since:
            params["updated_since"] = updated_since
        if created_since:
            params["created_since"] = created_since
        if action_since:
            params["action_since"] = action_since
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request("/bills", params)

    def get_bill(
        self,
        jurisdiction: str,
        session: str,
        bill_id: str,
        include: str | None = None,
    ) -> dict:
        """Get a specific bill by jurisdiction, session, and identifier.

        Args:
            jurisdiction: State name or abbreviation (e.g. 'California' or 'ca')
            session: Legislative session identifier
            bill_id: Bill identifier (e.g. 'HB 1', 'SB 100')
            include: Comma-separated includes (sponsorships, abstracts, other_titles, other_identifiers, actions, sources, documents, versions, votes, related_bills)
        """
        params: dict = {}
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request(f"/bills/{jurisdiction}/{session}/{bill_id}", params)

    def get_bill_by_id(
        self,
        openstates_bill_id: str,
        include: str | None = None,
    ) -> dict:
        """Get a bill by its Open States internal UUID.

        Args:
            openstates_bill_id: Open States bill UUID
            include: Comma-separated includes (sponsorships, abstracts, other_titles, other_identifiers, actions, sources, documents, versions, votes, related_bills)
        """
        params: dict = {}
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request(f"/bills/ocd-bill/{openstates_bill_id}", params)

    # ── Committees ────────────────────────────────────────────────

    def list_committees(
        self,
        jurisdiction: str,
        chamber: str | None = None,
        include: str | None = None,
        page: int = 1,
        per_page: int = 20,
    ) -> dict:
        """List committees for a jurisdiction.

        Args:
            jurisdiction: State name or OCD ID
            chamber: Chamber (upper, lower)
            include: Comma-separated includes (memberships, links, sources)
            page: Page number
            per_page: Results per page
        """
        params: dict = {"jurisdiction": jurisdiction, "page": page, "per_page": per_page}
        if chamber:
            params["chamber"] = chamber
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request("/committees", params)

    def get_committee(
        self,
        committee_id: str,
        include: str | None = None,
    ) -> dict:
        """Get details for a single committee by ID.

        Args:
            committee_id: Committee OCD ID
            include: Comma-separated includes (memberships, links, sources)
        """
        params: dict = {}
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request(f"/committees/{committee_id}", params)

    # ── Events ────────────────────────────────────────────────────

    def list_events(
        self,
        jurisdiction: str | None = None,
        before: str | None = None,
        after: str | None = None,
        require_bills: bool = False,
        include: str | None = None,
        page: int = 1,
        per_page: int = 20,
    ) -> dict:
        """List legislative events (hearings, floor sessions, etc.).

        Args:
            jurisdiction: State name or OCD ID
            before: Return events starting before this datetime (ISO format)
            after: Return events starting after this datetime (ISO format)
            require_bills: Only return events with associated bills
            include: Comma-separated includes (links, sources, media, documents, participants, agenda)
            page: Page number
            per_page: Results per page
        """
        params: dict = {"page": page, "per_page": per_page}
        if jurisdiction:
            params["jurisdiction"] = jurisdiction
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        if require_bills:
            params["require_bills"] = True
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request("/events", params)

    def get_event(
        self,
        event_id: str,
        include: str | None = None,
    ) -> dict:
        """Get details for a single event by ID.

        Args:
            event_id: Event OCD ID
            include: Comma-separated includes (links, sources, media, documents, participants, agenda)
        """
        params: dict = {}
        if include:
            for val in include.split(","):
                params.setdefault("include", []).append(val.strip())
        return self._request(f"/events/{event_id}", params)

    def close(self):
        if self._http:
            self._http.close()
            self._http = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> PluralClient:
    return PluralClient()
