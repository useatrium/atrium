"""Coin Metrics API client."""


import httpx

from centaur_sdk import secret


class CoinMetricsClient:
    """Client for Coin Metrics API v4."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        """Initialize the Coin Metrics client.

        Args:
            api_key: Optional API key
            timeout: Request timeout in seconds
        """
        self._api_key = api_key
        self.base_url = "https://api.coinmetrics.io/v4"
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
        return secret("COINMETRICS_API_KEY", "")

    def _request(
        self,
        endpoint: str,
        params: dict | None = None,
    ) -> dict | list:
        """Make an API request.

        Args:
            endpoint: API endpoint path (e.g., "/catalog/assets")
            params: Optional query parameters

        Returns:
            JSON response data

        Raises:
            RuntimeError: If the request fails
        """
        url = f"{self.base_url}{endpoint}"
        params = params or {}

        api_key = self._get_api_key()
        if api_key:
            params["api_key"] = api_key

        try:
            response = self.client.get(url, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def raw_request(self, endpoint: str, params: dict | None = None) -> dict | list:
        """Make a raw API call to any endpoint.

        Args:
            endpoint: Full API endpoint path
            params: Optional query parameters

        Returns:
            JSON response data
        """
        return self._request(endpoint, params)

    # === Reference Data ===

    def list_assets(self) -> list[dict]:
        """List available assets.

        Returns:
            List of asset data including id, full_name, metrics
        """
        data = self._request("/reference-data/assets")
        return data.get("data", []) if isinstance(data, dict) else data

    def list_metrics(self) -> list[dict]:
        """List available metrics.

        Returns:
            List of metric metadata
        """
        data = self._request("/reference-data/asset-metrics")
        return data.get("data", []) if isinstance(data, dict) else data

    def list_exchanges(self) -> list[dict]:
        """List available exchanges.

        Returns:
            List of exchange data
        """
        data = self._request("/reference-data/exchanges")
        return data.get("data", []) if isinstance(data, dict) else data

    def list_markets(self) -> list[dict]:
        """List available markets.

        Returns:
            List of market data
        """
        data = self._request("/reference-data/markets")
        return data.get("data", []) if isinstance(data, dict) else data

    # === Timeseries ===

    def get_asset_metrics(
        self,
        assets: str,
        metrics: str,
        frequency: str = "1d",
        start_time: str | None = None,
        end_time: str | None = None,
        page_size: int = 1000,
    ) -> list[dict]:
        """Get timeseries data for asset metrics.

        Args:
            assets: Comma-separated list of assets (e.g., "btc,eth")
            metrics: Comma-separated list of metrics (e.g., "PriceUSD,AdrActCnt")
            frequency: Frequency (1b, 1s, 1m, 5m, 10m, 1h, 1d)
            start_time: Start time in ISO8601 format
            end_time: End time in ISO8601 format
            page_size: Number of results per page

        Returns:
            List of timeseries data points
        """
        params = {
            "assets": assets,
            "metrics": metrics,
            "frequency": frequency,
            "page_size": page_size,
        }
        if start_time:
            params["start_time"] = start_time
        if end_time:
            params["end_time"] = end_time

        data = self._request("/timeseries/asset-metrics", params)
        return data.get("data", []) if isinstance(data, dict) else data

    def get_catalog_asset_metrics(self, assets: str | None = None) -> list[dict]:
        """Get available metrics for assets from catalog.

        Args:
            assets: Optional comma-separated list of assets to filter

        Returns:
            List of asset-metric availability data
        """
        params = {}
        if assets:
            params["assets"] = assets

        data = self._request("/catalog-v2/asset-metrics", params)
        return data.get("data", []) if isinstance(data, dict) else data

    # === Market Data ===

    def get_market_candles(
        self,
        markets: str,
        frequency: str = "1h",
        start_time: str | None = None,
        end_time: str | None = None,
        page_size: int = 1000,
    ) -> list[dict]:
        """Get market candles (OHLCV).

        Args:
            markets: Comma-separated list of markets (e.g., "coinbase-btc-usd-spot")
            frequency: Candle frequency (1m, 5m, 10m, 15m, 30m, 1h, 4h, 1d)
            start_time: Start time in ISO8601 format
            end_time: End time in ISO8601 format
            page_size: Number of results per page

        Returns:
            List of candle data
        """
        params = {
            "markets": markets,
            "frequency": frequency,
            "page_size": page_size,
        }
        if start_time:
            params["start_time"] = start_time
        if end_time:
            params["end_time"] = end_time

        data = self._request("/timeseries/market-candles", params)
        return data.get("data", []) if isinstance(data, dict) else data

    def get_market_trades(
        self,
        markets: str,
        start_time: str | None = None,
        end_time: str | None = None,
        page_size: int = 1000,
    ) -> list[dict]:
        """Get market trades.

        Args:
            markets: Comma-separated list of markets
            start_time: Start time in ISO8601 format
            end_time: End time in ISO8601 format
            page_size: Number of results per page

        Returns:
            List of trade data
        """
        params = {
            "markets": markets,
            "page_size": page_size,
        }
        if start_time:
            params["start_time"] = start_time
        if end_time:
            params["end_time"] = end_time

        data = self._request("/timeseries/market-trades", params)
        return data.get("data", []) if isinstance(data, dict) else data

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> CoinMetricsClient:
    api_key = secret("COINMETRICS_API_KEY", "")
    return CoinMetricsClient(api_key=api_key)
