"""Crunchbase Enterprise API client."""

from typing import Any

import httpx

from centaur_sdk import secret


# Map common LLM-emitted field name mistakes to the real Crunchbase v4 field_ids.
# LLMs tend to drop the `_identifiers` suffix or pluralize the wrong part.
_FIELD_ALIASES: dict[str, str] = {
    "lead_investors": "lead_investor_identifiers",
    "lead_investor": "lead_investor_identifiers",
    "investors": "investor_identifiers",
    "investor": "investor_identifiers",
    "funded_organization": "funded_organization_identifier",
    "company": "funded_organization_identifier",
    "primary_organization_name": "primary_organization",
}


def _normalize_field_ids(field_ids: list[str] | None) -> list[str] | None:
    """Rewrite common field-name mistakes to real Crunchbase field_ids.

    Preserves order and removes duplicates introduced by the alias rewrite.
    """
    if not field_ids:
        return field_ids
    seen: set[str] = set()
    out: list[str] = []
    for fid in field_ids:
        mapped = _FIELD_ALIASES.get(fid, fid)
        if mapped not in seen:
            seen.add(mapped)
            out.append(mapped)
    return out


class CrunchbaseClient:
    """Client for Crunchbase Enterprise API v4."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.base_url = "https://api.crunchbase.com/v4/data"
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
        return secret("CRUNCHBASE_API_KEY", "")

    def _request(
        self,
        method: str,
        endpoint: str,
        params: dict | None = None,
        json_body: dict | None = None,
    ) -> dict | list:
        """Make an API request."""
        api_key = self._get_api_key()
        if not api_key:
            raise RuntimeError("CRUNCHBASE_API_KEY not set.")

        url = f"{self.base_url}{endpoint}"
        headers = {"X-cb-user-key": api_key, "Content-Type": "application/json"}

        try:
            if method.upper() == "GET":
                response = self.client.get(url, params=params, headers=headers)
            elif method.upper() == "POST":
                response = self.client.post(url, params=params, headers=headers, json=json_body)
            else:
                raise ValueError(f"Unsupported method: {method}")

            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def get_organization(
        self,
        entity_id: str,
        field_ids: list[str] | None = None,
        card_ids: list[str] | None = None,
    ) -> dict:
        """Lookup an organization by permalink or UUID."""
        params = {}
        field_ids = _normalize_field_ids(field_ids)
        if field_ids:
            params["field_ids"] = ",".join(field_ids)
        if card_ids:
            params["card_ids"] = ",".join(card_ids)
        return self._request("GET", f"/entities/organizations/{entity_id}", params=params)

    def get_organization_card(
        self,
        entity_id: str,
        card_id: str,
        card_field_ids: list[str] | None = None,
        limit: int = 100,
        after_id: str | None = None,
        order: str | None = None,
    ) -> dict:
        """Get a specific card for an organization (for pagination)."""
        params = {"limit": limit}
        card_field_ids = _normalize_field_ids(card_field_ids)
        if card_field_ids:
            params["card_field_ids"] = ",".join(card_field_ids)
        if after_id:
            params["after_id"] = after_id
        if order:
            params["order"] = order
        return self._request(
            "GET", f"/entities/organizations/{entity_id}/cards/{card_id}", params=params
        )

    def get_person(
        self,
        entity_id: str,
        field_ids: list[str] | None = None,
        card_ids: list[str] | None = None,
    ) -> dict:
        """Lookup a person by permalink or UUID."""
        params = {}
        field_ids = _normalize_field_ids(field_ids)
        if field_ids:
            params["field_ids"] = ",".join(field_ids)
        if card_ids:
            params["card_ids"] = ",".join(card_ids)
        return self._request("GET", f"/entities/people/{entity_id}", params=params)

    def get_funding_round(
        self,
        entity_id: str,
        field_ids: list[str] | None = None,
        card_ids: list[str] | None = None,
    ) -> dict:
        """Lookup a funding round by UUID."""
        params = {}
        field_ids = _normalize_field_ids(field_ids)
        if field_ids:
            params["field_ids"] = ",".join(field_ids)
        if card_ids:
            params["card_ids"] = ",".join(card_ids)
        return self._request("GET", f"/entities/funding_rounds/{entity_id}", params=params)

    def get_acquisition(
        self,
        entity_id: str,
        field_ids: list[str] | None = None,
        card_ids: list[str] | None = None,
    ) -> dict:
        """Lookup an acquisition by UUID."""
        params = {}
        field_ids = _normalize_field_ids(field_ids)
        if field_ids:
            params["field_ids"] = ",".join(field_ids)
        if card_ids:
            params["card_ids"] = ",".join(card_ids)
        return self._request("GET", f"/entities/acquisitions/{entity_id}", params=params)

    def get_ipo(
        self,
        entity_id: str,
        field_ids: list[str] | None = None,
        card_ids: list[str] | None = None,
    ) -> dict:
        """Lookup an IPO by UUID."""
        params = {}
        field_ids = _normalize_field_ids(field_ids)
        if field_ids:
            params["field_ids"] = ",".join(field_ids)
        if card_ids:
            params["card_ids"] = ",".join(card_ids)
        return self._request("GET", f"/entities/ipos/{entity_id}", params=params)

    def get_fund(
        self,
        entity_id: str,
        field_ids: list[str] | None = None,
        card_ids: list[str] | None = None,
    ) -> dict:
        """Lookup a fund by UUID."""
        params = {}
        field_ids = _normalize_field_ids(field_ids)
        if field_ids:
            params["field_ids"] = ",".join(field_ids)
        if card_ids:
            params["card_ids"] = ",".join(card_ids)
        return self._request("GET", f"/entities/funds/{entity_id}", params=params)

    def search_organizations(
        self,
        field_ids: list[str],
        query: list[dict[str, Any]] | None = None,
        order: list[dict[str, str]] | None = None,
        limit: int = 50,
        after_id: str | None = None,
    ) -> dict:
        """Search for organizations."""
        body: dict[str, Any] = {"field_ids": _normalize_field_ids(field_ids) or [], "limit": limit}
        if query:
            body["query"] = query
        if order:
            body["order"] = order
        if after_id:
            body["after_id"] = after_id
        return self._request("POST", "/searches/organizations", json_body=body)

    def search_people(
        self,
        field_ids: list[str],
        query: list[dict[str, Any]] | None = None,
        order: list[dict[str, str]] | None = None,
        limit: int = 50,
        after_id: str | None = None,
    ) -> dict:
        """Search for people."""
        body: dict[str, Any] = {"field_ids": _normalize_field_ids(field_ids) or [], "limit": limit}
        if query:
            body["query"] = query
        if order:
            body["order"] = order
        if after_id:
            body["after_id"] = after_id
        return self._request("POST", "/searches/people", json_body=body)

    def search_funding_rounds(
        self,
        field_ids: list[str],
        query: list[dict[str, Any]] | None = None,
        order: list[dict[str, str]] | None = None,
        limit: int = 50,
        after_id: str | None = None,
    ) -> dict:
        """Search for funding rounds."""
        body: dict[str, Any] = {"field_ids": _normalize_field_ids(field_ids) or [], "limit": limit}
        if query:
            body["query"] = query
        if order:
            body["order"] = order
        if after_id:
            body["after_id"] = after_id
        return self._request("POST", "/searches/funding_rounds", json_body=body)

    def search_acquisitions(
        self,
        field_ids: list[str],
        query: list[dict[str, Any]] | None = None,
        order: list[dict[str, str]] | None = None,
        limit: int = 50,
        after_id: str | None = None,
    ) -> dict:
        """Search for acquisitions."""
        body: dict[str, Any] = {"field_ids": _normalize_field_ids(field_ids) or [], "limit": limit}
        if query:
            body["query"] = query
        if order:
            body["order"] = order
        if after_id:
            body["after_id"] = after_id
        return self._request("POST", "/searches/acquisitions", json_body=body)

    def search_investments(
        self,
        field_ids: list[str],
        query: list[dict[str, Any]] | None = None,
        order: list[dict[str, str]] | None = None,
        limit: int = 50,
        after_id: str | None = None,
    ) -> dict:
        """Search for investments."""
        body: dict[str, Any] = {"field_ids": _normalize_field_ids(field_ids) or [], "limit": limit}
        if query:
            body["query"] = query
        if order:
            body["order"] = order
        if after_id:
            body["after_id"] = after_id
        return self._request("POST", "/searches/investments", json_body=body)

    def autocomplete(
        self,
        query: str,
        collection_ids: list[str] | None = None,
        limit: int = 10,
    ) -> dict:
        """Autocomplete search for entities."""
        params = {"query": query, "limit": limit}
        if collection_ids:
            params["collection_ids"] = ",".join(collection_ids)
        return self._request("GET", "/autocompletes", params=params)

    def get_deleted_entities(
        self,
        collection_id: str | None = None,
        deleted_at_gte: str | None = None,
        limit: int = 100,
    ) -> dict:
        """Get deleted entities."""
        params = {"limit": limit}
        if deleted_at_gte:
            params["deleted_at_gte"] = deleted_at_gte
        if collection_id:
            return self._request("GET", f"/deleted_entities/{collection_id}", params=params)
        return self._request("GET", "/deleted_entities", params=params)

    def raw(
        self,
        method: str,
        endpoint: str,
        params: dict | None = None,
        json_body: dict | None = None,
    ) -> dict | list:
        """Make a raw API call."""
        return self._request(method, endpoint, params=params, json_body=json_body)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> CrunchbaseClient:
    """Factory: create a CrunchbaseClient from env vars."""
    return CrunchbaseClient(api_key=secret("CRUNCHBASE_API_KEY", ""))
