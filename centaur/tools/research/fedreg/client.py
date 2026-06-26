"""Federal Register API client."""

import httpx


class FederalRegisterClient:
    """Client for the Federal Register API (v1)."""

    BASE_URL = "https://www.federalregister.gov/api/v1"

    def __init__(self, timeout: float = 60.0):
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _request(self, endpoint: str, params: dict | None = None) -> dict:
        """Make an API request."""
        url = f"{self.BASE_URL}{endpoint}"

        headers = {"Accept": "application/json"}

        try:
            response = self.client.get(url, headers=headers, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def search_articles(
        self,
        term: str,
        type: str | None = None,
        agency: str | None = None,
        page: int = 1,
        per_page: int = 20,
        order: str = "relevance",
    ) -> dict:
        """Search Federal Register documents.

        Args:
            term: Search query
            type: Document type (RULE, PRORULE, NOTICE, PRESDOCU)
            agency: Agency slug (e.g. securities-and-exchange-commission)
            page: Page number
            per_page: Results per page
            order: Sort order (newest, oldest, relevance)
        """
        params: dict = {
            "conditions[term]": term,
            "page": page,
            "per_page": per_page,
            "order": order,
        }
        if type:
            params["conditions[type][]"] = type
        if agency:
            params["conditions[agencies][]"] = agency

        return self._request("/articles.json", params)

    def get_article(self, document_number: str) -> dict:
        """Get a single document by FR document number."""
        return self._request(f"/articles/{document_number}.json")

    def get_agencies(self) -> list:
        """List all agencies."""
        return self._request("/agencies.json")

    def get_agency(self, slug: str) -> dict:
        """Get details for a single agency by slug."""
        return self._request(f"/agencies/{slug}.json")

    def get_public_inspection(
        self,
        agency: str | None = None,
        type: str | None = None,
    ) -> dict:
        """Get current public inspection documents.

        Args:
            agency: Agency slug filter
            type: Document type filter
        """
        params: dict = {}
        if agency:
            params["conditions[agencies][]"] = agency
        if type:
            params["conditions[type][]"] = type

        return self._request("/public-inspection-documents/current.json", params)

    def search_open_comments(
        self,
        agency: str | None = None,
        per_page: int = 20,
    ) -> dict:
        """Search for documents with open comment periods.

        Args:
            agency: Agency slug filter
            per_page: Results per page
        """
        from datetime import date

        params: dict = {
            "conditions[comment_date][gte]": date.today().isoformat(),
            "per_page": per_page,
        }
        if agency:
            params["conditions[agencies][]"] = agency

        return self._request("/articles.json", params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> FederalRegisterClient:
    """Factory: create a FederalRegisterClient (no credentials needed)."""
    return FederalRegisterClient()
