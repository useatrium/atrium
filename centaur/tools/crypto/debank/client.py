"""DeBank Pro API client."""


import httpx

from centaur_sdk import secret


class DeBankClient:
    """Client for DeBank Pro API."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.base_url = "https://pro-openapi.debank.com"
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
        return secret("DEBANK_API_KEY", "")

    def _request(
        self,
        endpoint: str,
        params: dict | None = None,
    ) -> dict | list:
        """Make an API request."""
        api_key = self._get_api_key()
        if not api_key:
            raise RuntimeError("DEBANK_API_KEY not set.")

        url = f"{self.base_url}{endpoint}"
        headers = {"AccessKey": api_key}

        try:
            response = self.client.get(url, params=params, headers=headers)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    # Chain APIs
    def get_chain_list(self) -> list[dict]:
        """Get list of supported chains."""
        return self._request("/v1/chain/list")

    # User APIs
    def get_user_total_balance(self, address: str) -> dict:
        """Get user's total balance across all chains."""
        return self._request("/v1/user/total_balance", params={"id": address})

    def get_user_chain_balance(self, address: str, chain_id: str) -> dict:
        """Get user's balance on a specific chain."""
        return self._request("/v1/user/chain_balance", params={"id": address, "chain_id": chain_id})

    def get_user_token_list(self, address: str, chain_id: str, is_all: bool = True) -> list[dict]:
        """Get user's token list on a chain."""
        return self._request(
            "/v1/user/token_list",
            params={"id": address, "chain_id": chain_id, "is_all": str(is_all).lower()},
        )

    def get_user_all_token_list(
        self, address: str, is_all: bool = True, chain_ids: str | None = None
    ) -> list[dict]:
        """Get user's token list across all chains."""
        params = {"id": address, "is_all": str(is_all).lower()}
        if chain_ids:
            params["chain_ids"] = chain_ids
        return self._request("/v1/user/all_token_list", params=params)

    def get_user_protocol(self, address: str, protocol_id: str) -> dict:
        """Get user's positions in a specific protocol."""
        return self._request(
            "/v1/user/protocol", params={"id": address, "protocol_id": protocol_id}
        )

    def get_user_simple_protocol_list(self, address: str, chain_id: str) -> list[dict]:
        """Get user's protocol list (simple, with balances)."""
        return self._request(
            "/v1/user/simple_protocol_list", params={"id": address, "chain_id": chain_id}
        )

    def get_user_all_simple_protocol_list(self, address: str) -> list[dict]:
        """Get user's protocol list across all chains (simple)."""
        return self._request("/v1/user/all_simple_protocol_list", params={"id": address})

    def get_user_complex_protocol_list(self, address: str, chain_id: str) -> list[dict]:
        """Get user's protocol list with detailed positions."""
        return self._request(
            "/v1/user/complex_protocol_list", params={"id": address, "chain_id": chain_id}
        )

    def get_user_all_complex_protocol_list(self, address: str) -> list[dict]:
        """Get user's protocol list across all chains (detailed)."""
        return self._request("/v1/user/all_complex_protocol_list", params={"id": address})

    def get_user_nft_list(self, address: str, chain_id: str, is_all: bool = False) -> list[dict]:
        """Get user's NFT list on a chain."""
        return self._request(
            "/v1/user/nft_list",
            params={"id": address, "chain_id": chain_id, "is_all": str(is_all).lower()},
        )

    def get_user_total_net_curve(self, address: str, chain_ids: str | None = None) -> list[dict]:
        """Get user's net worth history curve."""
        params = {"id": address}
        if chain_ids:
            params["chain_ids"] = chain_ids
        return self._request("/v1/user/total_net_curve", params=params)

    # Token APIs
    def get_token(self, chain_id: str, token_id: str) -> dict:
        """Get token info."""
        return self._request("/v1/token", params={"chain_id": chain_id, "id": token_id})

    def get_token_list_by_ids(self, chain_id: str, token_ids: str) -> list[dict]:
        """Get multiple tokens by IDs."""
        return self._request(
            "/v1/token/list_by_ids", params={"chain_id": chain_id, "ids": token_ids}
        )

    # Protocol APIs
    def get_protocol(self, protocol_id: str) -> dict:
        """Get protocol info."""
        return self._request("/v1/protocol", params={"id": protocol_id})

    def get_protocol_list(self, chain_id: str) -> list[dict]:
        """Get list of protocols on a chain."""
        return self._request("/v1/protocol/list", params={"chain_id": chain_id})

    def get_protocol_all_list(self) -> list[dict]:
        """Get list of all protocols."""
        return self._request("/v1/protocol/all_list")

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> DeBankClient:
    """Factory: create a DeBankClient from env vars."""
    return DeBankClient(api_key=secret("DEBANK_API_KEY", ""))
