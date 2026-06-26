"""Pylon API client."""

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from centaur_sdk import secret

BASE_URL = "https://api.usepylon.com"


class PylonClient:
    """Client for Pylon support API."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.timeout = timeout

    def _get_api_key(self) -> str:
        """Get Pylon API key from environment."""
        key = self._api_key or secret("PYLON_API_KEY", "")
        if not key:
            raise RuntimeError(
                "PYLON_API_KEY not set.\n"
                "Add PYLON_API_KEY to .env file or set as environment variable."
            )
        return key

    def _request(self, method: str, endpoint: str, **kwargs) -> dict:
        """Make authenticated request to Pylon API."""
        api_key = self._get_api_key()
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        with httpx.Client(timeout=self.timeout) as client:
            response = client.request(method, f"{BASE_URL}{endpoint}", headers=headers, **kwargs)

            if response.status_code >= 400:
                try:
                    error = response.json()
                    msg = error.get("error", {}).get("message", response.text)
                except Exception:
                    msg = response.text
                raise RuntimeError(f"Pylon API error ({response.status_code}): {msg}")

            return response.json()

    def get_me(self) -> dict:
        """Get details of the organization associated with the API token."""
        return self._request("GET", "/me")

    def list_issues(
        self,
        start_time: str | None = None,
        end_time: str | None = None,
        days: int = 7,
    ) -> list[dict]:
        """Get a list of issues within a time range.

        Args:
            start_time: RFC3339 start time (default: 7 days ago)
            end_time: RFC3339 end time (default: now)
            days: Number of days to look back if start_time not specified

        Returns:
            List of issue dicts
        """
        if not end_time:
            end_time = datetime.now(timezone.utc).isoformat()
        if not start_time:
            start_dt = datetime.now(timezone.utc) - timedelta(days=days)
            start_time = start_dt.isoformat()

        response = self._request(
            "GET", "/issues", params={"start_time": start_time, "end_time": end_time}
        )
        return response.get("data", [])

    def get_issue(self, issue_id: str) -> dict:
        """Get an issue by its ID or number."""
        response = self._request("GET", f"/issues/{issue_id}")
        return response.get("data", {})

    def search_issues(
        self,
        filter_obj: dict[str, Any],
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict:
        """Search for issues by a given filter.

        Args:
            filter_obj: Filter object with field, operator, value
            limit: Maximum issues to return (1-1000)
            cursor: Pagination cursor

        Returns:
            Dict with data and pagination info
        """
        body: dict[str, Any] = {"filter": filter_obj, "limit": limit}
        if cursor:
            body["cursor"] = cursor

        return self._request("POST", "/issues/search", json=body)

    def create_issue(
        self,
        title: str,
        body_html: str,
        requester_email: str | None = None,
        account_id: str | None = None,
        assignee_id: str | None = None,
        priority: str | None = None,
        tags: list[str] | None = None,
        team_id: str | None = None,
    ) -> dict:
        """Create a new issue.

        Args:
            title: Issue title
            body_html: HTML content of the issue body
            requester_email: Email of the requester
            account_id: Account ID this issue belongs to
            assignee_id: User ID to assign the issue to
            priority: urgent, high, medium, or low
            tags: List of tag strings
            team_id: Team ID to assign to

        Returns:
            Created issue dict
        """
        payload: dict[str, Any] = {"title": title, "body_html": body_html}

        if requester_email:
            payload["requester_email"] = requester_email
        if account_id:
            payload["account_id"] = account_id
        if assignee_id:
            payload["assignee_id"] = assignee_id
        if priority:
            payload["priority"] = priority
        if tags:
            payload["tags"] = tags
        if team_id:
            payload["team_id"] = team_id

        response = self._request("POST", "/issues", json=payload)
        return response.get("data", {})

    def update_issue(
        self,
        issue_id: str,
        state: str | None = None,
        assignee_id: str | None = None,
        tags: list[str] | None = None,
        team_id: str | None = None,
        account_id: str | None = None,
    ) -> dict:
        """Update an existing issue.

        Args:
            issue_id: Issue ID to update
            state: new, waiting_on_you, waiting_on_customer, on_hold, closed
            assignee_id: User ID to assign (empty string to unassign)
            tags: Tags to set (replaces existing)
            team_id: Team ID to assign (empty string to unassign)
            account_id: Account ID to associate

        Returns:
            Updated issue dict
        """
        payload: dict[str, Any] = {}

        if state:
            payload["state"] = state
        if assignee_id is not None:
            payload["assignee_id"] = assignee_id
        if tags is not None:
            payload["tags"] = tags
        if team_id is not None:
            payload["team_id"] = team_id
        if account_id:
            payload["account_id"] = account_id

        response = self._request("PATCH", f"/issues/{issue_id}", json=payload)
        return response.get("data", {})

    def delete_issue(self, issue_id: str) -> dict:
        """Delete an existing issue."""
        return self._request("DELETE", f"/issues/{issue_id}")

    def list_accounts(self, limit: int = 100, cursor: str | None = None) -> dict:
        """Get a list of accounts.

        Args:
            limit: Maximum accounts to return (1-1000)
            cursor: Pagination cursor

        Returns:
            Dict with data and pagination info
        """
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor

        return self._request("GET", "/accounts", params=params)

    def get_account(self, account_id: str) -> dict:
        """Get an account by its ID or external ID."""
        response = self._request("GET", f"/accounts/{account_id}")
        return response.get("data", {})

    def search_accounts(
        self,
        filter_obj: dict[str, Any],
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict:
        """Search for accounts by a given filter.

        Args:
            filter_obj: Filter object with field, operator, value
            limit: Maximum accounts to return (1-1000)
            cursor: Pagination cursor

        Returns:
            Dict with data and pagination info
        """
        body: dict[str, Any] = {"filter": filter_obj, "limit": limit}
        if cursor:
            body["cursor"] = cursor

        return self._request("POST", "/accounts/search", json=body)

    def create_account(
        self,
        name: str,
        domains: list[str] | None = None,
        primary_domain: str | None = None,
        tags: list[str] | None = None,
        owner_id: str | None = None,
    ) -> dict:
        """Create a new account.

        Args:
            name: Account name
            domains: List of domains (without scheme)
            primary_domain: Primary domain (must be in domains list)
            tags: List of tag strings
            owner_id: Owner user ID

        Returns:
            Created account dict
        """
        payload: dict[str, Any] = {"name": name}

        if domains:
            payload["domains"] = domains
        if primary_domain:
            payload["primary_domain"] = primary_domain
        if tags:
            payload["tags"] = tags
        if owner_id:
            payload["owner_id"] = owner_id

        response = self._request("POST", "/accounts", json=payload)
        return response.get("data", {})

    def update_account(
        self,
        account_id: str,
        name: str | None = None,
        domains: list[str] | None = None,
        primary_domain: str | None = None,
        tags: list[str] | None = None,
        owner_id: str | None = None,
    ) -> dict:
        """Update an existing account."""
        payload: dict[str, Any] = {}

        if name:
            payload["name"] = name
        if domains:
            payload["domains"] = domains
        if primary_domain:
            payload["primary_domain"] = primary_domain
        if tags is not None:
            payload["tags"] = tags
        if owner_id is not None:
            payload["owner_id"] = owner_id

        response = self._request("PATCH", f"/accounts/{account_id}", json=payload)
        return response.get("data", {})

    def list_contacts(self) -> list[dict]:
        """Get all contacts."""
        response = self._request("GET", "/contacts")
        return response.get("data", [])

    def get_contact(self, contact_id: str) -> dict:
        """Get a contact by its ID."""
        response = self._request("GET", f"/contacts/{contact_id}")
        return response.get("data", {})

    def search_contacts(
        self,
        filter_obj: dict[str, Any],
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict:
        """Search for contacts by a given filter.

        Args:
            filter_obj: Filter object with field, operator, value
            limit: Maximum contacts to return (1-1000)
            cursor: Pagination cursor

        Returns:
            Dict with data and pagination info
        """
        body: dict[str, Any] = {"filter": filter_obj, "limit": limit}
        if cursor:
            body["cursor"] = cursor

        return self._request("POST", "/contacts/search", json=body)

    def create_contact(
        self,
        name: str,
        email: str | None = None,
        account_id: str | None = None,
    ) -> dict:
        """Create a new contact.

        Args:
            name: Contact name
            email: Contact email
            account_id: Account to associate with

        Returns:
            Created contact dict
        """
        payload: dict[str, Any] = {"name": name}

        if email:
            payload["email"] = email
        if account_id:
            payload["account_id"] = account_id

        response = self._request("POST", "/contacts", json=payload)
        return response.get("data", {})

    def list_users(self) -> list[dict]:
        """Get a list of users."""
        response = self._request("GET", "/users")
        return response.get("data", [])

    def get_user(self, user_id: str) -> dict:
        """Get a user by its ID."""
        response = self._request("GET", f"/users/{user_id}")
        return response.get("data", {})

    def list_teams(self) -> list[dict]:
        """Get a list of teams."""
        response = self._request("GET", "/teams")
        return response.get("data", [])

    def list_tags(self) -> list[dict]:
        """Get all tags."""
        response = self._request("GET", "/tags")
        return response.get("data", [])


def _client() -> PylonClient:
    return PylonClient()
