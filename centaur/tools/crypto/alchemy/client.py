"""Alchemy API client."""

from __future__ import annotations

from typing import Any

import httpx

from centaur_sdk import secret

SUPPORTED_CHAINS = {
    "ethereum": "eth-mainnet",
    "eth": "eth-mainnet",
    "mainnet": "eth-mainnet",
    "sepolia": "eth-sepolia",
    "polygon": "polygon-mainnet",
    "arbitrum": "arb-mainnet",
    "arb": "arb-mainnet",
    "optimism": "opt-mainnet",
    "opt": "opt-mainnet",
    "base": "base-mainnet",
    "solana": "solana-mainnet",
    "sol": "solana-mainnet",
    "zksync": "zksync-mainnet",
    "avalanche": "avax-mainnet",
    "avax": "avax-mainnet",
    "bnb": "bnb-mainnet",
    "fantom": "fantom-mainnet",
    "scroll": "scroll-mainnet",
    "linea": "linea-mainnet",
    "zora": "zora-mainnet",
    "blast": "blast-mainnet",
    "monad": "monad-mainnet",
}


def get_chain_url(chain: str) -> str:
    """Get the RPC URL prefix for a chain."""
    normalized = chain.lower().replace(" ", "-")
    if normalized in SUPPORTED_CHAINS:
        return SUPPORTED_CHAINS[normalized]
    return normalized


class AlchemyClient:
    """Client for the Alchemy blockchain API."""

    def __init__(self, api_key: str | None = None, chain: str = "ethereum"):
        self.api_key = api_key
        self.chain = chain
        self._http_client: httpx.Client | None = None
        self._prices_client: httpx.Client | None = None

    def _get_api_key(self) -> str:
        """Get API key from env var."""
        if self.api_key:
            return self.api_key
        key = secret("ALCHEMY_API_KEY", "")
        if key:
            return key
        raise RuntimeError("ALCHEMY_API_KEY not set.")

    def _get_rpc_url(self, chain: str | None = None) -> str:
        """Get the RPC URL for the specified chain."""
        chain_prefix = get_chain_url(chain or self.chain)
        return f"https://{chain_prefix}.g.alchemy.com/v2/{self._get_api_key()}"

    def _get_prices_url(self) -> str:
        """Get the Prices API base URL."""
        return "https://api.g.alchemy.com/prices/v1"

    @property
    def http_client(self) -> httpx.Client:
        """Get or create HTTP client for RPC calls."""
        if self._http_client is None:
            self._http_client = httpx.Client(
                headers={"Content-Type": "application/json"},
                timeout=60.0,
            )
        return self._http_client

    @property
    def prices_client(self) -> httpx.Client:
        """Get or create HTTP client for Prices API."""
        if self._prices_client is None:
            self._prices_client = httpx.Client(
                base_url=self._get_prices_url(),
                headers={
                    "Authorization": f"Bearer {self._get_api_key()}",
                    "Content-Type": "application/json",
                },
                timeout=60.0,
            )
        return self._prices_client

    def close(self) -> None:
        """Close the HTTP clients."""
        if self._http_client is not None:
            self._http_client.close()
            self._http_client = None
        if self._prices_client is not None:
            self._prices_client.close()
            self._prices_client = None

    def __enter__(self) -> "AlchemyClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _rpc_call(self, method: str, params: list | dict, chain: str | None = None) -> Any:
        """Make a JSON-RPC call to Alchemy."""
        url = self._get_rpc_url(chain)
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params if isinstance(params, list) else [params],
            "id": 1,
        }
        response = self.http_client.post(url, json=payload)
        response.raise_for_status()
        result = response.json()
        if "error" in result:
            raise RuntimeError(f"RPC error: {result['error']}")
        return result.get("result")

    def get_balance(self, address: str, chain: str | None = None) -> int:
        """Get native token balance for an address."""
        result = self._rpc_call("eth_getBalance", [address, "latest"], chain)
        return int(result, 16) if result else 0

    def get_token_balances(
        self,
        address: str,
        token_addresses: list[str] | None = None,
        chain: str | None = None,
    ) -> dict:
        """Get ERC-20 token balances for an address."""
        params = [address]
        if token_addresses:
            params.append(token_addresses)
        else:
            params.append("erc20")
        return self._rpc_call("alchemy_getTokenBalances", params, chain)

    def get_token_metadata(self, token_address: str, chain: str | None = None) -> dict:
        """Get metadata for an ERC-20 token."""
        return self._rpc_call("alchemy_getTokenMetadata", [token_address], chain)

    def get_asset_transfers(
        self,
        from_address: str | None = None,
        to_address: str | None = None,
        from_block: str = "0x0",
        to_block: str = "latest",
        categories: list[str] | None = None,
        max_count: int = 100,
        exclude_zero_value: bool = True,
        chain: str | None = None,
    ) -> dict:
        """Get asset transfers for an address."""
        params: dict[str, Any] = {
            "fromBlock": from_block,
            "toBlock": to_block,
            "maxCount": hex(max_count),
            "excludeZeroValue": exclude_zero_value,
            "withMetadata": True,
        }
        if from_address:
            params["fromAddress"] = from_address
        if to_address:
            params["toAddress"] = to_address
        if categories:
            params["category"] = categories
        else:
            params["category"] = ["external", "internal", "erc20"]

        return self._rpc_call("alchemy_getAssetTransfers", [params], chain)

    def get_block_number(self, chain: str | None = None) -> int:
        """Get the current block number."""
        result = self._rpc_call("eth_blockNumber", [], chain)
        return int(result, 16) if result else 0

    def get_gas_price(self, chain: str | None = None) -> int:
        """Get current gas price."""
        result = self._rpc_call("eth_gasPrice", [], chain)
        return int(result, 16) if result else 0

    def get_transaction(self, tx_hash: str, chain: str | None = None) -> dict | None:
        """Get transaction by hash."""
        return self._rpc_call("eth_getTransactionByHash", [tx_hash], chain)

    def get_transaction_receipt(self, tx_hash: str, chain: str | None = None) -> dict | None:
        """Get transaction receipt."""
        return self._rpc_call("eth_getTransactionReceipt", [tx_hash], chain)

    def get_logs(
        self,
        address: str | list[str] | None = None,
        topics: list[str | list[str] | None] | None = None,
        from_block: str = "latest",
        to_block: str = "latest",
        chain: str | None = None,
    ) -> list[dict]:
        """Get event logs."""
        params: dict[str, Any] = {
            "fromBlock": from_block,
            "toBlock": to_block,
        }
        if address:
            params["address"] = address
        if topics:
            params["topics"] = topics
        return self._rpc_call("eth_getLogs", [params], chain)

    def get_prices_by_symbol(self, symbols: list[str]) -> dict:
        """Get token prices by symbol."""
        params = "&".join(f"symbols={s}" for s in symbols)
        response = self.prices_client.get(f"/tokens/by-symbol?{params}")
        response.raise_for_status()
        return response.json()

    def get_prices_by_address(self, addresses: list[dict[str, str]]) -> dict:
        """Get token prices by contract address."""
        response = self.prices_client.post("/tokens/by-address", json={"addresses": addresses})
        response.raise_for_status()
        return response.json()

    def get_historical_prices(
        self,
        symbol: str | None = None,
        address: str | None = None,
        network: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> dict:
        """Get historical token prices."""
        params: dict[str, Any] = {}
        if symbol:
            params["symbol"] = symbol
        if address:
            params["address"] = address
        if network:
            params["network"] = network
        if start_time:
            params["startTime"] = start_time
        if end_time:
            params["endTime"] = end_time

        query = "&".join(f"{k}={v}" for k, v in params.items())
        response = self.prices_client.get(f"/tokens/historical?{query}")
        response.raise_for_status()
        return response.json()


def format_wei(wei: int, decimals: int = 18) -> str:
    """Format wei amount to human-readable string."""
    value = wei / (10**decimals)
    if value >= 1000000:
        return f"{value:,.2f}"
    elif value >= 1:
        return f"{value:.4f}"
    else:
        return f"{value:.8f}"


def format_gwei(wei: int) -> str:
    """Format wei to gwei."""
    gwei = wei / 1e9
    return f"{gwei:.2f} gwei"


def _client() -> AlchemyClient:
    api_key = secret("ALCHEMY_API_KEY", "")
    if not api_key:
        raise RuntimeError("ALCHEMY_API_KEY not set.")
    return AlchemyClient(api_key=api_key)
