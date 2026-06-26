"""Standard Metrics API client with OAuth2 client credentials authentication."""

import base64
import time
from typing import Any

import httpx
from centaur_sdk.tool_sdk import secret

BASE_URL = "https://api.standardmetrics.io/v1"
TOKEN_URL = "https://api.standardmetrics.io/o/token/"


class StandardMetricsClient:
    """Client for Standard Metrics API."""

    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        timeout: float = 30.0,
    ):
        self._client_id = client_id
        self._client_secret = client_secret
        self.timeout = timeout
        self._token_cache: dict[str, Any] = {}

    def _get_credentials(self) -> tuple[str, str]:
        """Get client credentials from environment."""
        client_id = self._client_id or secret("STANDARD_METRICS_CLIENT_ID", "")
        client_secret = self._client_secret or secret("STANDARD_METRICS_CLIENT_SECRET", "")
        if not client_id or not client_secret:
            raise RuntimeError(
                "STANDARD_METRICS_CLIENT_ID and STANDARD_METRICS_CLIENT_SECRET must be set.\n"
                "Create OAuth credentials at https://app.standardmetrics.io/settings/developers"
            )
        return client_id, client_secret

    def _get_access_token(self) -> str:
        """Get access token, using cache if valid."""
        if self._token_cache:
            expires_at = self._token_cache.get("expires_at", 0)
            if time.time() < expires_at - 60:
                return self._token_cache["access_token"]

        client_id, client_secret = self._get_credentials()
        credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()

        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                TOKEN_URL,
                headers={
                    "Authorization": f"Basic {credentials}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={"grant_type": "client_credentials"},
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    f"Failed to get access token: {response.status_code} {response.text}"
                )
            data = response.json()

        self._token_cache = {
            "access_token": data["access_token"],
            "expires_at": time.time() + data.get("expires_in", 3600),
        }
        return self._token_cache["access_token"]

    def _get_http_client(self) -> httpx.Client:
        """Get authenticated HTTP client."""
        token = self._get_access_token()
        return httpx.Client(
            base_url=BASE_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            timeout=self.timeout,
            follow_redirects=True,
        )

    def _request(self, method: str, path: str, **kwargs) -> dict[str, Any]:
        """Make authenticated request to Standard Metrics API."""
        with self._get_http_client() as client:
            response = client.request(method, path, **kwargs)
            if response.status_code >= 400:
                try:
                    error = response.json()
                    msg = error.get("detail", error.get("message", response.text))
                except Exception:
                    msg = response.text
                raise RuntimeError(f"Standard Metrics API error ({response.status_code}): {msg}")
            return response.json()

    def list_companies(
        self,
        page: int = 1,
        page_size: int = 100,
        name: str | None = None,
        ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """List portfolio companies."""
        params: dict[str, Any] = {"page": page, "page_size": page_size}
        if name:
            params["name"] = name
        if ids:
            for company_id in ids:
                params.setdefault("ids[]", []).append(company_id)
        return self._request("GET", "/companies/", params=params)

    def get_company(self, company_id: str) -> dict[str, Any]:
        """Get company by ID - fetches from list filtered by ID."""
        result = self.list_companies(ids=[company_id])
        companies = result.get("results", [])
        if not companies:
            raise RuntimeError(f"Company not found: {company_id}")
        return companies[0]

    def get_metrics(
        self,
        company_id: str | None = None,
        company_slug: str | None = None,
        category: str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        cadence: str | None = None,
        page: int = 1,
        page_size: int = 100,
    ) -> dict[str, Any]:
        """Get metrics for a company."""
        if not company_id and not company_slug:
            raise ValueError("Either company_id or company_slug must be provided")

        params: dict[str, Any] = {"page": page, "page_size": page_size}
        if company_id:
            params["company_id"] = company_id
        if company_slug:
            params["company_slug"] = company_slug
        if category:
            params["category"] = category
        if from_date:
            params["from"] = from_date
        if to_date:
            params["to"] = to_date
        if cadence:
            params["cadence"] = cadence
        return self._request("GET", "/metrics/", params=params)

    def get_documents(
        self,
        company_id: str | None = None,
        parse_state: str | None = None,
        source: str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        page: int = 1,
        page_size: int = 100,
    ) -> dict[str, Any]:
        """Get documents for a company."""
        params: dict[str, Any] = {"page": page, "page_size": page_size}
        if company_id:
            params["company_id"] = company_id
        if parse_state:
            params["parse_state"] = parse_state
        if source:
            params["source"] = source
        if from_date:
            params["from"] = from_date
        if to_date:
            params["to"] = to_date
        return self._request("GET", "/documents/", params=params)

    def get_budgets(
        self,
        company_id: str | None = None,
        page: int = 1,
        page_size: int = 100,
    ) -> dict[str, Any]:
        """Get budgets for a company."""
        params: dict[str, Any] = {"page": page, "page_size": page_size}
        if company_id:
            params["company_id"] = company_id
        return self._request("GET", "/budgets/", params=params)

    def get_funds(self, page: int = 1, page_size: int = 100) -> dict[str, Any]:
        """Get funds."""
        return self._request("GET", "/funds/", params={"page": page, "page_size": page_size})

    def get_notes(
        self,
        company_id: str | None = None,
        page: int = 1,
        page_size: int = 100,
    ) -> dict[str, Any]:
        """Get notes for a company."""
        params: dict[str, Any] = {"page": page, "page_size": page_size}
        if company_id:
            params["company_id"] = company_id
        return self._request("GET", "/notes/", params=params)

    def raw_request(
        self, method: str, endpoint: str, params: dict | None = None
    ) -> dict[str, Any]:
        """Make a raw API request."""
        return self._request(method, endpoint, params=params)


def _client() -> StandardMetricsClient:
    return StandardMetricsClient()
