"""Arkham Intelligence API client."""


import httpx

from centaur_sdk import secret


class ArkhamClient:
    """Client for Arkham Intelligence API."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.base_url = "https://api.arkm.com"
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
        return secret("ARKHAM_API_KEY", "")

    def _request(
        self,
        endpoint: str,
        params: dict | None = None,
    ) -> dict | list:
        """Make an API request."""
        api_key = self._get_api_key()
        if not api_key:
            raise RuntimeError("ARKHAM_API_KEY not set.")

        url = f"{self.base_url}{endpoint}"
        headers = {"API-Key": api_key}

        try:
            response = self.client.get(url, params=params, headers=headers)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def health(self) -> dict:
        """Check API health."""
        url = f"{self.base_url}/health"
        resp = self.client.get(url)
        resp.raise_for_status()
        body = resp.text.strip()
        if not body or resp.headers.get("content-type", "").startswith("text/"):
            return {"status": body or "ok", "code": resp.status_code}
        return resp.json()

    def chains(self) -> list:
        """Get supported chains."""
        return self._request("/chains")

    def get_address_intelligence(self, address: str) -> dict:
        """Get intelligence for an address."""
        return self._request(f"/intelligence/address/{address}")

    def get_address_intelligence_all(self, address: str) -> dict:
        """Get all intelligence for an address across chains."""
        return self._request(f"/intelligence/address/{address}/all")

    def get_address_enriched(
        self,
        address: str,
        include_tags: bool = True,
        include_clusters: bool = False,
        include_entity_predictions: bool = False,
    ) -> dict:
        """Get enriched address intelligence."""
        params = {
            "includeTags": str(include_tags).lower(),
            "includeClusters": str(include_clusters).lower(),
            "includeEntityPredictions": str(include_entity_predictions).lower(),
        }
        return self._request(f"/intelligence/address_enriched/{address}", params=params)

    def get_entity(self, entity: str) -> dict:
        """Get entity details."""
        return self._request(f"/intelligence/entity/{entity}")

    def get_entity_summary(self, entity: str) -> dict:
        """Get entity summary statistics."""
        return self._request(f"/intelligence/entity/{entity}/summary")

    def get_entity_predictions(self, entity: str) -> dict:
        """Get predicted addresses for entity."""
        return self._request(f"/intelligence/entity_predictions/{entity}")

    def get_contract(self, chain: str, address: str) -> dict:
        """Get contract intelligence."""
        return self._request(f"/intelligence/contract/{chain}/{address}")

    def get_token(self, pricing_id: str) -> dict:
        """Get token intelligence by pricing ID."""
        return self._request(f"/intelligence/token/{pricing_id}")

    def get_token_by_address(self, chain: str, address: str) -> dict:
        """Get token intelligence by chain and address."""
        return self._request(f"/intelligence/token/{chain}/{address}")

    def get_transfers(
        self,
        base: str | None = None,
        flow: str | None = None,
        chain: str | None = None,
        token_id: str | None = None,
        usd_gte: float | None = None,
        usd_lte: float | None = None,
        time_gte: str | None = None,
        time_lte: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """Get transfers with filters."""
        params = {"limit": limit, "offset": offset}
        if base:
            params["base"] = base
        if flow:
            params["flow"] = flow
        if chain:
            params["chain"] = chain
        if token_id:
            params["tokenId"] = token_id
        if usd_gte is not None:
            params["usdGte"] = usd_gte
        if usd_lte is not None:
            params["usdLte"] = usd_lte
        if time_gte:
            params["timeGte"] = time_gte
        if time_lte:
            params["timeLte"] = time_lte
        return self._request("/transfers", params=params)

    def get_swaps(
        self,
        base: str | None = None,
        chain: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """Get DEX swaps with filters."""
        params = {"limit": limit, "offset": offset}
        if base:
            params["base"] = base
        if chain:
            params["chain"] = chain
        return self._request("/swaps", params=params)

    def get_transaction(self, tx_hash: str) -> dict:
        """Get transaction details by hash."""
        return self._request(f"/tx/{tx_hash}")

    def get_portfolio_address(self, address: str, chain: str | None = None) -> dict:
        """Get portfolio for an address."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/portfolio/address/{address}", params=params)

    def get_portfolio_entity(self, entity: str, chain: str | None = None) -> dict:
        """Get portfolio for an entity."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/portfolio/entity/{entity}", params=params)

    def get_portfolio_timeseries_address(self, address: str, chain: str | None = None) -> list:
        """Get portfolio time series for address."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/portfolio/timeSeries/address/{address}", params=params)

    def get_portfolio_timeseries_entity(self, entity: str, chain: str | None = None) -> list:
        """Get portfolio time series for entity."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/portfolio/timeSeries/entity/{entity}", params=params)

    def get_history_address(self, address: str) -> list:
        """Get historical USD value for address."""
        return self._request(f"/history/address/{address}")

    def get_history_entity(self, entity: str) -> list:
        """Get historical USD value for entity."""
        return self._request(f"/history/entity/{entity}")

    def get_balances_address(self, address: str, chain: str | None = None) -> dict:
        """Get token balances for address."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/balances/address/{address}", params=params)

    def get_balances_entity(self, entity: str, chain: str | None = None) -> dict:
        """Get token balances for entity."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/balances/entity/{entity}", params=params)

    def get_flow_address(self, address: str, chain: str | None = None) -> dict:
        """Get USD flows for address."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/flow/address/{address}", params=params)

    def get_flow_entity(self, entity: str, chain: str | None = None) -> dict:
        """Get USD flows for entity."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/flow/entity/{entity}", params=params)

    def get_counterparties_address(
        self,
        address: str,
        flow: str | None = None,
        chain: str | None = None,
        limit: int = 20,
    ) -> dict:
        """Get top counterparties for address."""
        params = {"limit": limit}
        if flow:
            params["flow"] = flow
        if chain:
            params["chain"] = chain
        return self._request(f"/counterparties/address/{address}", params=params)

    def get_counterparties_entity(
        self,
        entity: str,
        flow: str | None = None,
        chain: str | None = None,
        limit: int = 20,
    ) -> dict:
        """Get top counterparties for entity."""
        params = {"limit": limit}
        if flow:
            params["flow"] = flow
        if chain:
            params["chain"] = chain
        return self._request(f"/counterparties/entity/{entity}", params=params)

    def get_token_holders(
        self,
        pricing_id: str,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """Get token holders by pricing ID."""
        params = {"limit": limit, "offset": offset}
        return self._request(f"/token/holders/{pricing_id}", params=params)

    def get_token_holders_by_address(
        self,
        chain: str,
        address: str,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """Get token holders by chain and address."""
        params = {"limit": limit, "offset": offset}
        return self._request(f"/token/holders/{chain}/{address}", params=params)

    def get_token_trending(self, chain: str | None = None) -> list:
        """Get trending tokens."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request("/token/trending", params=params)

    def get_token_top_flow(
        self,
        pricing_id: str,
        flow: str | None = None,
        limit: int = 20,
    ) -> dict:
        """Get top addresses by token flow."""
        params = {"limit": limit}
        if flow:
            params["flow"] = flow
        return self._request(f"/token/top_flow/{pricing_id}", params=params)

    def get_token_volume(
        self,
        pricing_id: str,
        interval: str = "1h",
    ) -> list:
        """Get token volume over time."""
        params = {"interval": interval}
        return self._request(f"/token/volume/{pricing_id}", params=params)

    def get_token_top(
        self,
        sort_by: str = "volume",
        interval: str = "24h",
        limit: int = 20,
    ) -> dict:
        """Get top tokens by exchange movements."""
        params = {"sortBy": sort_by, "interval": interval, "limit": limit}
        return self._request("/token/top", params=params)

    def get_networks_status(self) -> list:
        """Get status of all supported networks."""
        return self._request("/networks/status")

    def get_network_history(self, chain: str) -> list:
        """Get historical quotes for a chain."""
        return self._request(f"/networks/history/{chain}")

    def get_altcoin_index(self) -> dict:
        """Get altcoin index market data."""
        return self._request("/marketdata/altcoin_index")

    def get_loans_address(self, address: str, chain: str | None = None) -> dict:
        """Get loan positions for address."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/loans/address/{address}", params=params)

    def get_loans_entity(self, entity: str, chain: str | None = None) -> dict:
        """Get loan positions for entity."""
        params = {}
        if chain:
            params["chain"] = chain
        return self._request(f"/loans/entity/{entity}", params=params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> ArkhamClient:
    return ArkhamClient()
