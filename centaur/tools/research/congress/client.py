"""Congress.gov API client."""


import httpx
from centaur_sdk.tool_sdk import secret


class CongressClient:
    """Client for Congress.gov API (v3)."""

    BASE_URL = "https://api.congress.gov/v3"

    def __init__(
        self,
        api_key: str | None = None,
        timeout: float = 60.0,
    ):
        self._api_key = api_key
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _get_api_key(self) -> str:
        api_key = self._api_key or secret("DATAGOV_API_KEY", "")
        if not api_key:
            raise RuntimeError("DATAGOV_API_KEY not set.")
        return api_key

    def _request(self, endpoint: str, params: dict | None = None) -> dict:
        """Make an API request."""
        api_key = self._get_api_key()
        url = f"{self.BASE_URL}{endpoint}"

        if params is None:
            params = {}
        params["api_key"] = api_key
        params["format"] = "json"

        try:
            response = self.client.get(url, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def list_bills(
        self,
        congress: int = 119,
        bill_type: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List bills.

        Args:
            congress: Congress number (e.g. 119)
            bill_type: Bill type (hr, s, hjres, sjres) or None for all
            limit: Max results
            offset: Offset for pagination
        """
        if bill_type:
            endpoint = f"/bill/{congress}/{bill_type}"
        else:
            endpoint = f"/bill/{congress}"
        params = {"limit": limit, "offset": offset}
        return self._request(endpoint, params)

    def get_bill(
        self,
        congress: int,
        bill_type: str,
        number: int,
        detail: str | None = None,
    ) -> dict:
        """Get a specific bill.

        Args:
            congress: Congress number
            bill_type: Bill type (hr, s, hjres, sjres)
            number: Bill number
            detail: Sub-resource (actions, amendments, cosponsors, subjects, summaries, text)
        """
        endpoint = f"/bill/{congress}/{bill_type}/{number}"
        if detail:
            endpoint = f"{endpoint}/{detail}"
        return self._request(endpoint)

    def list_members(
        self,
        congress: int = 119,
        state: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List members of Congress.

        Args:
            congress: Congress number
            state: State postal code (e.g. CA, NY)
            limit: Max results
            offset: Offset for pagination
        """
        endpoint = f"/member/congress/{congress}"
        params: dict = {"limit": limit, "offset": offset}
        if state:
            params["currentMember"] = True
            endpoint = f"/member/congress/{congress}/{state}"
        return self._request(endpoint, params)

    def get_member(self, bioguide_id: str) -> dict:
        """Get a specific member by bioguide ID.

        Args:
            bioguide_id: Bioguide identifier (e.g. L000174)
        """
        return self._request(f"/member/{bioguide_id}")

    def list_committees(
        self,
        congress: int = 119,
        chamber: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List committees.

        Args:
            congress: Congress number
            chamber: house, senate, or joint
            limit: Max results
            offset: Offset for pagination
        """
        if chamber:
            endpoint = f"/committee/{chamber}/{congress}"
        else:
            endpoint = f"/committee/{congress}"
        params = {"limit": limit, "offset": offset}
        return self._request(endpoint, params)

    def list_hearings(
        self,
        congress: int = 119,
        chamber: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List hearings.

        Args:
            congress: Congress number
            chamber: house or senate
            limit: Max results
            offset: Offset for pagination
        """
        if chamber:
            endpoint = f"/hearing/{congress}/{chamber}"
        else:
            endpoint = f"/hearing/{congress}"
        params = {"limit": limit, "offset": offset}
        return self._request(endpoint, params)

    def list_votes(
        self,
        congress: int = 119,
        chamber: str | None = None,
        session: int | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List roll call votes.

        Args:
            congress: Congress number
            chamber: house or senate
            session: Session number (1 or 2)
            limit: Max results
            offset: Offset for pagination
        """
        if chamber and session:
            endpoint = f"/rollcall/{congress}/{chamber}/{session}"
        elif chamber:
            endpoint = f"/rollcall/{congress}/{chamber}"
        else:
            endpoint = f"/rollcall/{congress}"
        params = {"limit": limit, "offset": offset}
        return self._request(endpoint, params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> CongressClient:
    return CongressClient()
