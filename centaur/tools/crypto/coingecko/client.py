"""CoinGecko Pro API client."""


import httpx

from centaur_sdk import secret


class CoinGeckoClient:
    """Client for CoinGecko Pro API."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.base_url = "https://pro-api.coingecko.com/api/v3"
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _get_api_key(self) -> str | None:
        """Get API key from instance or env var."""
        if self._api_key:
            return self._api_key
        return secret("COINGECKO_API_KEY", "")

    def _request(
        self,
        endpoint: str,
        params: dict | None = None,
    ) -> dict | list:
        """Make an API request."""
        api_key = self._get_api_key()
        if not api_key:
            raise RuntimeError("COINGECKO_API_KEY not set.")

        url = f"{self.base_url}{endpoint}"
        headers = {"x-cg-pro-api-key": api_key}

        try:
            response = self.client.get(url, params=params, headers=headers)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def get_price(
        self,
        ids: str,
        vs_currencies: str = "usd",
        include_market_cap: bool = True,
        include_24hr_vol: bool = True,
        include_24hr_change: bool = True,
    ) -> dict:
        """Get current price for coins."""
        params = {
            "ids": ids,
            "vs_currencies": vs_currencies,
            "include_market_cap": str(include_market_cap).lower(),
            "include_24hr_vol": str(include_24hr_vol).lower(),
            "include_24hr_change": str(include_24hr_change).lower(),
        }
        return self._request("/simple/price", params=params)

    def get_markets(
        self,
        vs_currency: str = "usd",
        order: str = "market_cap_desc",
        per_page: int = 100,
        page: int = 1,
        sparkline: bool = False,
    ) -> list[dict]:
        """List coins by market cap."""
        params = {
            "vs_currency": vs_currency,
            "order": order,
            "per_page": per_page,
            "page": page,
            "sparkline": str(sparkline).lower(),
        }
        return self._request("/coins/markets", params=params)

    def get_coin(self, coin_id: str) -> dict:
        """Get coin details."""
        params = {
            "localization": "false",
            "tickers": "false",
            "market_data": "true",
            "community_data": "false",
            "developer_data": "false",
        }
        return self._request(f"/coins/{coin_id}", params=params)

    def get_trending(self) -> dict:
        """Get trending coins."""
        return self._request("/search/trending")

    def search(self, query: str) -> dict:
        """Search for coins."""
        return self._request("/search", params={"query": query})

    def get_market_chart(
        self,
        coin_id: str,
        vs_currency: str = "usd",
        days: int | str = 30,
    ) -> dict:
        """Get historical market data."""
        params = {
            "vs_currency": vs_currency,
            "days": str(days),
        }
        return self._request(f"/coins/{coin_id}/market_chart", params=params)

    def get_categories(self) -> list[dict]:
        """List all categories."""
        return self._request("/coins/categories")

    def get_exchanges(self, per_page: int = 100, page: int = 1) -> list[dict]:
        """List exchanges."""
        params = {"per_page": per_page, "page": page}
        return self._request("/exchanges", params=params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> CoinGeckoClient:
    api_key = secret("COINGECKO_API_KEY", "")
    if not api_key:
        raise RuntimeError("COINGECKO_API_KEY not set.")
    return CoinGeckoClient(api_key=api_key)
