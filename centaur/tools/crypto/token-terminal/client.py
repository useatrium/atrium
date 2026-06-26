"""Token Terminal API client."""


import httpx

from centaur_sdk import secret


class TokenTerminalClient:
    """Client for Token Terminal API.

    Provides access to protocol revenue, fees, financial statements, and metrics.
    """

    BASE_URL = "https://api.tokenterminal.com/v2"

    def __init__(self, api_key: str, timeout: float = 30.0):
        self._api_key = api_key
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _request(
        self,
        endpoint: str,
        params: dict | None = None,
    ) -> dict | list:
        """Make an API request."""
        url = f"{self.BASE_URL}{endpoint}"
        headers = {
            "accept": "application/json",
            "authorization": f"Bearer {self._api_key}",
        }

        try:
            response = self.client.get(url, headers=headers, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    # === Projects ===

    def list_projects(self, limit: int = 50) -> list[dict]:
        """List all projects.

        Args:
            limit: Maximum number of projects to return

        Returns:
            List of project data
        """
        return self._request("/projects", params={"limit": limit})

    def get_project(self, project_id: str) -> dict:
        """Get details for a specific project.

        Args:
            project_id: The project ID (e.g., "aave", "uniswap")

        Returns:
            Project details
        """
        return self._request(f"/projects/{project_id}")

    def get_project_metrics(
        self,
        project_id: str,
        metric: str = "fees",
        interval: str = "daily",
        limit: int = 30,
    ) -> list[dict]:
        """Get metrics for a specific project.

        Args:
            project_id: The project ID
            metric: Metric type (e.g., "fees", "revenue", "tvl")
            interval: Time interval ("daily", "weekly", "monthly")
            limit: Maximum number of data points

        Returns:
            List of metric data points
        """
        return self._request(
            f"/projects/{project_id}/metrics",
            params={"metric": metric, "interval": interval, "limit": limit},
        )

    def get_financial_statement(
        self,
        project_id: str,
        interval: str = "quarterly",
    ) -> dict:
        """Get financial statement for a specific project.

        Args:
            project_id: The project ID
            interval: Time interval ("quarterly", "annual")

        Returns:
            Financial statement data
        """
        return self._request(
            f"/projects/{project_id}/financial-statements",
            params={"interval": interval},
        )

    # === Market Sectors ===

    def list_market_sectors(self) -> list[dict]:
        """List all market sectors.

        Returns:
            List of market sector data
        """
        return self._request("/market-sectors")

    def get_market_sector_metrics(
        self,
        sector: str,
        metric: str = "fees",
        interval: str = "daily",
        limit: int = 30,
    ) -> list[dict]:
        """Get metrics for a specific market sector.

        Args:
            sector: Market sector identifier
            metric: Metric type (e.g., "fees", "revenue", "tvl")
            interval: Time interval ("daily", "weekly", "monthly")
            limit: Maximum number of data points

        Returns:
            List of metric data points
        """
        return self._request(
            f"/market-sectors/{sector}/metrics",
            params={"metric": metric, "interval": interval, "limit": limit},
        )

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> TokenTerminalClient:
    api_key = secret("TOKEN_TERMINAL_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "TOKEN_TERMINAL_API_KEY not set. "
            "Export it or add it to .env"
        )
    return TokenTerminalClient(api_key=api_key)
