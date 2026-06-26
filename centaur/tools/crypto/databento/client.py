"""Databento Historical API client for stock market data."""

import json
from typing import Any

import httpx

from centaur_sdk.tool_sdk import secret

BASE_URL = "https://hist.databento.com/v0"


class DatabentoClient:
    """Client for the Databento Historical API."""

    def __init__(self, api_key: str | None = None, timeout: float = 60.0):
        self._api_key = api_key or secret("DATABENTO_API_KEY", "")
        if not self._api_key:
            raise RuntimeError(
                "DATABENTO_API_KEY not set.\n"
                "Get your key at https://databento.com/portal/keys"
            )
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                base_url=BASE_URL,
                auth=(self._api_key, ""),
                timeout=self.timeout,
            )
        return self._client

    def get_stock_prices(
        self,
        symbol: str,
        start_date: str,
        end_date: str,
        schema: str = "ohlcv-1d",
    ) -> list[dict[str, Any]]:
        """Get OHLCV stock price data from Databento.

        Args:
            symbol: Ticker symbol (e.g., AAPL, MSFT)
            start_date: Start date in YYYY-MM-DD format
            end_date: End date in YYYY-MM-DD format
            schema: Data schema (e.g., ohlcv-1d, ohlcv-1m, ohlcv-1h)

        Returns:
            List of OHLCV price records
        """
        params = {
            "dataset": "XNAS.ITCH",
            "symbols": symbol,
            "schema": schema,
            "start": start_date,
            "end": end_date,
            "encoding": "json",
            "stype_in": "raw_symbol",
        }

        try:
            response = self.client.get("/timeseries.get_range", params=params)
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

        if response.status_code in (422, 403):
            return []

        if response.status_code >= 400:
            try:
                error = response.json()
                msg = error.get("message", error.get("error", response.text))
            except Exception:
                msg = response.text
            raise RuntimeError(f"Databento API error ({response.status_code}): {msg}")

        results = []
        for line in response.text.split("\n"):
            trimmed = line.strip()
            if trimmed:
                results.append(json.loads(trimmed))
        return results

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> DatabentoClient:
    return DatabentoClient(api_key=secret("DATABENTO_API_KEY", ""))
