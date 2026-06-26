"""Polymarket API client."""

import httpx


class PolymarketClient:

    """Client for Polymarket APIs (Gamma and CLOB)."""

    def __init__(self, timeout: float = 30.0):
        self.gamma_url = "https://gamma-api.polymarket.com"
        self.clob_url = "https://clob.polymarket.com"
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _request(self, url: str, params: dict | None = None) -> dict | list:
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
        limit: int = 20,
        offset: int = 0,
        closed: bool = False,
        order: str = "volumeNum",
        ascending: bool = False,
    ) -> list[dict]:
        """List markets from Gamma API."""
        params = {
            "limit": limit,
            "offset": offset,
            "closed": str(closed).lower(),
            "order": order,
            "ascending": str(ascending).lower(),
        }
        return self._request(f"{self.gamma_url}/markets", params)

    def get_market(self, market_id: str) -> dict:
        """Get market by ID or slug."""
        if market_id.isdigit():
            return self._request(f"{self.gamma_url}/markets/{market_id}")
        return self._request(f"{self.gamma_url}/markets/slug/{market_id}")

    def list_events(
        self,
        limit: int = 20,
        offset: int = 0,
        closed: bool = False,
        order: str = "id",
        ascending: bool = False,
    ) -> list[dict]:
        """List events from Gamma API."""
        params = {
            "limit": limit,
            "offset": offset,
            "closed": str(closed).lower(),
            "order": order,
            "ascending": str(ascending).lower(),
        }
        return self._request(f"{self.gamma_url}/events", params)

    def get_event(self, event_id: str) -> dict:
        """Get event by ID or slug."""
        if event_id.isdigit():
            return self._request(f"{self.gamma_url}/events/{event_id}")
        return self._request(f"{self.gamma_url}/events/slug/{event_id}")

    def search(
        self,
        query: str,
        limit: int = 20,
        closed: bool = False,
    ) -> dict:
        """Search markets, events, and profiles."""
        params = {
            "q": query,
            "limit_per_type": limit,
            "keep_closed_markets": 1 if closed else 0,
        }
        return self._request(f"{self.gamma_url}/public-search", params)

    def get_price(self, token_id: str, side: str = "buy") -> dict:
        """Get current price for a token from CLOB.

        Args:
            token_id: CLOB token ID
            side: Order side ("buy" or "sell")
        """
        return self._request(
            f"{self.clob_url}/price", {"token_id": token_id, "side": side}
        )

    def get_prices(self, token_ids: list[str], side: str = "buy") -> list[dict]:
        """Get prices for multiple tokens.

        Args:
            token_ids: List of CLOB token IDs
            side: Order side ("buy" or "sell")
        """
        return self._request(
            f"{self.clob_url}/prices",
            {"token_ids": ",".join(token_ids), "side": side},
        )

    def get_book(self, token_id: str) -> dict:
        """Get orderbook for a token."""
        return self._request(f"{self.clob_url}/book", {"token_id": token_id})

    def get_midpoint(self, token_id: str) -> dict:
        """Get midpoint price for a token."""
        return self._request(f"{self.clob_url}/midpoint", {"token_id": token_id})

    def get_price_history(
        self,
        token_id: str,
        interval: str = "1w",
        fidelity: int | None = None,
    ) -> dict:
        """Get price history for a token.

        Args:
            token_id: CLOB token ID
            interval: 1m, 1w, 1d, 6h, 1h, or max
            fidelity: Resolution in minutes
        """
        params = {"market": token_id, "interval": interval}
        if fidelity:
            params["fidelity"] = fidelity
        return self._request(f"{self.clob_url}/prices-history", params)

    def get_trades(
        self,
        market: str | None = None,
        maker: str | None = None,
        before: int | None = None,
        after: int | None = None,
    ) -> list[dict]:
        """Get trades (requires authentication for user-specific trades)."""
        params = {}
        if market:
            params["market"] = market
        if maker:
            params["maker"] = maker
        if before:
            params["before"] = str(before)
        if after:
            params["after"] = str(after)
        return self._request(f"{self.clob_url}/data/trades", params)

    def close(self):
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()



def _client() -> PolymarketClient:
    return PolymarketClient()
