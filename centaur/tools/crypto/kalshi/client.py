"""Kalshi API client."""

import httpx


class KalshiClient:
    """Client for Kalshi API.

    Supports public endpoints for market data (no authentication required).
    """

    def __init__(self, timeout: float = 30.0):
        self.base_url = "https://api.elections.kalshi.com/trade-api/v2"
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
        """Make an API request.

        Args:
            endpoint: API endpoint path (e.g., "/markets")
            params: Optional query parameters

        Returns:
            JSON response data

        Raises:
            RuntimeError: If the request fails
        """
        url = f"{self.base_url}{endpoint}"

        try:
            response = self.client.get(url, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def list_markets(
        self,
        status: str | None = None,
        event_ticker: str | None = None,
        series_ticker: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict:
        """List markets with optional filters.

        Args:
            status: Filter by status (unopened, open, closed, settled)
            event_ticker: Filter by event ticker
            series_ticker: Filter by series ticker
            limit: Number of results (max 1000)
            cursor: Pagination cursor

        Returns:
            Dict with markets list and cursor
        """
        params = {"limit": limit}
        if status:
            params["status"] = status
        if event_ticker:
            params["event_ticker"] = event_ticker
        if series_ticker:
            params["series_ticker"] = series_ticker
        if cursor:
            params["cursor"] = cursor
        return self._request("/markets", params=params)

    def get_market(self, ticker: str) -> dict:
        """Get a specific market by ticker.

        Args:
            ticker: Market ticker (e.g., "KXBTC-24DEC31-99999")

        Returns:
            Market details
        """
        return self._request(f"/markets/{ticker}")

    def get_trades(
        self,
        ticker: str | None = None,
        min_ts: int | None = None,
        max_ts: int | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict:
        """Get trades for a market.

        Args:
            ticker: Market ticker to filter
            min_ts: Filter trades after this Unix timestamp
            max_ts: Filter trades before this Unix timestamp
            limit: Number of results (max 1000)
            cursor: Pagination cursor

        Returns:
            Dict with trades list and cursor
        """
        params = {"limit": limit}
        if ticker:
            params["ticker"] = ticker
        if min_ts:
            params["min_ts"] = min_ts
        if max_ts:
            params["max_ts"] = max_ts
        if cursor:
            params["cursor"] = cursor
        return self._request("/markets/trades", params=params)

    def get_candlesticks(
        self,
        series_ticker: str,
        ticker: str,
        start_ts: int,
        end_ts: int,
        period_interval: int = 1440,
    ) -> dict:
        """Get candlestick/OHLC data for a market.

        Args:
            series_ticker: Series ticker
            ticker: Market ticker
            start_ts: Start Unix timestamp
            end_ts: End Unix timestamp
            period_interval: Candle period in minutes (1, 60, or 1440)

        Returns:
            Dict with candlesticks data
        """
        params = {
            "start_ts": start_ts,
            "end_ts": end_ts,
            "period_interval": period_interval,
        }
        return self._request(
            f"/series/{series_ticker}/markets/{ticker}/candlesticks", params=params
        )

    def list_events(
        self,
        status: str | None = None,
        series_ticker: str | None = None,
        with_nested_markets: bool = False,
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict:
        """List events.

        Args:
            status: Filter by status (open, closed, settled)
            series_ticker: Filter by series ticker
            with_nested_markets: Include markets in response
            limit: Number of results (max 200)
            cursor: Pagination cursor

        Returns:
            Dict with events list and cursor
        """
        params = {"limit": min(limit, 200)}
        if status:
            params["status"] = status
        if series_ticker:
            params["series_ticker"] = series_ticker
        if with_nested_markets:
            params["with_nested_markets"] = "true"
        if cursor:
            params["cursor"] = cursor
        return self._request("/events", params=params)

    def get_event(self, event_ticker: str) -> dict:
        """Get a specific event by ticker.

        Args:
            event_ticker: Event ticker

        Returns:
            Event details
        """
        return self._request(f"/events/{event_ticker}")

    def list_series(self, limit: int = 100, cursor: str | None = None) -> dict:
        """List series (categories).

        Args:
            limit: Number of results
            cursor: Pagination cursor

        Returns:
            Dict with series list and cursor
        """
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        return self._request("/series", params=params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()



def _client() -> KalshiClient:
    return KalshiClient()
