"""Etherscan API client."""


import httpx

from centaur_sdk import secret


class EtherscanClient:
    """Client for Etherscan API V2.

    Supports querying account balances, transactions, token transfers,
    contract ABIs/source, gas prices, and event logs across multiple chains.
    """

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _get_api_key(self) -> str:
        """Get API key from instance or env var."""
        key = self._api_key or secret("ETHERSCAN_API_KEY", "")
        if not key:
            raise RuntimeError("ETHERSCAN_API_KEY not set.")
        return key

    def _request(self, chain_id: int, **params) -> dict | list | str:
        """Make an API request.

        Args:
            chain_id: Chain ID (1 for Ethereum mainnet)
            **params: Query parameters (module, action, etc.)

        Returns:
            The 'result' field from the API response
        """
        params["apikey"] = self._get_api_key()
        params["chainid"] = chain_id
        url = "https://api.etherscan.io/v2/api"
        try:
            response = self.client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            if data.get("status") == "0" and data.get("message") != "No transactions found":
                raise RuntimeError(f"Etherscan error: {data.get('result', data.get('message'))}")
            return data.get("result", data)
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    # === Account ===

    def get_balance(self, address: str, chain_id: int = 1) -> str:
        """Get ETH balance for an address.

        Args:
            address: Ethereum address
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            Balance in wei as a string
        """
        return self._request(
            chain_id, module="account", action="balance", address=address, tag="latest"
        )

    def get_transactions(
        self,
        address: str,
        start_block: int = 0,
        end_block: int = 99999999,
        page: int = 1,
        offset: int = 20,
        sort: str = "desc",
        chain_id: int = 1,
    ) -> list[dict]:
        """Get normal transactions for an address.

        Args:
            address: Ethereum address
            start_block: Start block number
            end_block: End block number
            page: Page number
            offset: Number of results per page
            sort: Sort order ('asc' or 'desc')
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            List of transaction objects
        """
        return self._request(
            chain_id,
            module="account",
            action="txlist",
            address=address,
            startblock=start_block,
            endblock=end_block,
            page=page,
            offset=offset,
            sort=sort,
        )

    def get_token_transfers(
        self,
        address: str,
        contract_address: str | None = None,
        page: int = 1,
        offset: int = 20,
        sort: str = "desc",
        chain_id: int = 1,
    ) -> list[dict]:
        """Get ERC-20 token transfer events for an address.

        Args:
            address: Ethereum address
            contract_address: Optional token contract address to filter
            page: Page number
            offset: Number of results per page
            sort: Sort order ('asc' or 'desc')
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            List of token transfer objects
        """
        params = dict(
            module="account",
            action="tokentx",
            address=address,
            page=page,
            offset=offset,
            sort=sort,
        )
        if contract_address:
            params["contractaddress"] = contract_address
        return self._request(chain_id, **params)

    # === Contract ===

    def get_contract_abi(self, address: str, chain_id: int = 1) -> str:
        """Get the ABI for a verified contract.

        Args:
            address: Contract address
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            ABI as a JSON string
        """
        return self._request(chain_id, module="contract", action="getabi", address=address)

    def get_contract_source(self, address: str, chain_id: int = 1) -> list[dict]:
        """Get source code for a verified contract.

        Args:
            address: Contract address
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            List of source code objects
        """
        return self._request(chain_id, module="contract", action="getsourcecode", address=address)

    # === Stats ===

    def get_eth_price(self, chain_id: int = 1) -> dict:
        """Get current ETH price.

        Args:
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            Price data with ethusd, ethbtc fields
        """
        return self._request(chain_id, module="stats", action="ethprice")

    def get_token_supply(self, contract_address: str, chain_id: int = 1) -> str:
        """Get total supply of an ERC-20 token.

        Args:
            contract_address: Token contract address
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            Total supply as a string
        """
        return self._request(
            chain_id, module="stats", action="tokensupply", contractaddress=contract_address
        )

    # === Proxy ===

    def get_gas_price(self, chain_id: int = 1) -> dict:
        """Get current gas price.

        Args:
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            Gas price data
        """
        return self._request(chain_id, module="proxy", action="eth_gasPrice")

    # === Logs ===

    def get_logs(
        self,
        address: str,
        from_block: int,
        to_block: int,
        topic0: str | None = None,
        chain_id: int = 1,
    ) -> list[dict]:
        """Get event logs for an address.

        Args:
            address: Contract address
            from_block: Start block number
            to_block: End block number
            topic0: Optional topic0 filter
            chain_id: Chain ID (default: 1 for mainnet)

        Returns:
            List of log objects
        """
        params = dict(
            module="logs",
            action="getLogs",
            address=address,
            fromBlock=from_block,
            toBlock=to_block,
        )
        if topic0:
            params["topic0"] = topic0
        return self._request(chain_id, **params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> EtherscanClient:
    api_key = secret("ETHERSCAN_API_KEY", "")
    if not api_key:
        raise RuntimeError("ETHERSCAN_API_KEY not set.")
    return EtherscanClient(api_key=api_key)
