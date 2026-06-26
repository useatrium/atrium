"""OpenFEC federal election API client."""


import httpx
from centaur_sdk.tool_sdk import secret


class OpenFECClient:
    """Client for OpenFEC API (api.open.fec.gov)."""

    BASE_URL = "https://api.open.fec.gov/v1"

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
        """Make an API request with api_key query parameter."""
        api_key = self._get_api_key()
        url = f"{self.BASE_URL}{endpoint}"

        if params is None:
            params = {}
        params["api_key"] = api_key

        try:
            response = self.client.get(url, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def search_candidates(
        self,
        name: str | None = None,
        state: str | None = None,
        party: str | None = None,
        office: str | None = None,
        cycle: int | None = None,
        per_page: int = 20,
        page: int = 1,
    ) -> dict:
        """Search for candidates.

        Args:
            name: Candidate name search
            state: Two-letter state code
            party: Party code (DEM, REP, etc.)
            office: H=House, S=Senate, P=President
            cycle: Election cycle year
            per_page: Results per page
            page: Page number
        """
        params = {"per_page": per_page, "page": page}
        if name:
            params["name"] = name
        if state:
            params["state"] = state
        if party:
            params["party"] = party
        if office:
            params["office"] = office
        if cycle:
            params["cycle"] = cycle

        return self._request("/candidates/search/", params)

    def get_candidate(self, candidate_id: str) -> dict:
        """Get a specific candidate by ID.

        Args:
            candidate_id: FEC candidate ID (e.g., H0CA12183)
        """
        return self._request(f"/candidate/{candidate_id}/")

    def search_committees(
        self,
        name: str | None = None,
        state: str | None = None,
        committee_type: str | None = None,
        cycle: int | None = None,
        per_page: int = 20,
        page: int = 1,
    ) -> dict:
        """Search for committees.

        Args:
            name: Committee name search
            state: Two-letter state code
            committee_type: Committee type code
            cycle: Election cycle year
            per_page: Results per page
            page: Page number
        """
        params = {"per_page": per_page, "page": page}
        if name:
            params["q"] = name
        if state:
            params["state"] = state
        if committee_type:
            params["committee_type"] = committee_type
        if cycle:
            params["cycle"] = cycle

        return self._request("/committees/", params)

    def get_contributions(
        self,
        committee_id: str | None = None,
        contributor_name: str | None = None,
        contributor_state: str | None = None,
        min_amount: float | None = None,
        max_amount: float | None = None,
        min_date: str | None = None,
        max_date: str | None = None,
        per_page: int = 20,
        page: int = 1,
    ) -> dict:
        """Get itemized contributions (Schedule A).

        Args:
            committee_id: Recipient committee ID
            contributor_name: Contributor name search
            contributor_state: Contributor state code
            min_amount: Minimum contribution amount
            max_amount: Maximum contribution amount
            min_date: Min date (YYYY-MM-DD)
            max_date: Max date (YYYY-MM-DD)
            per_page: Results per page
            page: Page number
        """
        params = {"per_page": per_page, "page": page}
        if committee_id:
            params["committee_id"] = committee_id
        if contributor_name:
            params["contributor_name"] = contributor_name
        if contributor_state:
            params["contributor_state"] = contributor_state
        if min_amount is not None:
            params["min_amount"] = min_amount
        if max_amount is not None:
            params["max_amount"] = max_amount
        if min_date:
            params["min_date"] = min_date
        if max_date:
            params["max_date"] = max_date

        return self._request("/schedules/schedule_a/", params)

    def get_filings(
        self,
        committee_id: str,
        form_type: str | None = None,
        per_page: int = 20,
        page: int = 1,
    ) -> dict:
        """Get committee filings.

        Args:
            committee_id: Committee ID
            form_type: Filing form type
            per_page: Results per page
            page: Page number
        """
        params = {"committee_id": committee_id, "per_page": per_page, "page": page}
        if form_type:
            params["form_type"] = form_type

        return self._request("/filings/", params)

    def get_candidate_totals(
        self,
        candidate_id: str,
        cycle: int | None = None,
    ) -> dict:
        """Get candidate financial totals.

        Args:
            candidate_id: FEC candidate ID
            cycle: Election cycle year
        """
        params = {}
        if cycle:
            params["cycle"] = cycle

        return self._request(f"/candidate/{candidate_id}/totals/", params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> OpenFECClient:
    return OpenFECClient()
