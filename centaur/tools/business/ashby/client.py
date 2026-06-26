"""Ashby API client."""

from typing import Any

import httpx
from centaur_sdk import secret

BASE_URL = "https://api.ashbyhq.com"


class AshbyClient:
    """Client for Ashby API."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or secret("ASHBY_API_KEY", "")
        if not self.api_key:
            raise RuntimeError(
                "ASHBY_API_KEY not set.\n"
                "Set it with: export ASHBY_API_KEY='your_key'\n"
                "Create a key at: https://app.ashbyhq.com/admin/api/keys"
            )

        self._client = httpx.Client(
            timeout=30.0,
            auth=(self.api_key, ""),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json; version=1",
            },
        )

    def _request(self, endpoint: str, data: dict | None = None) -> dict:
        """Make an authenticated request to the Ashby API."""
        response = self._client.post(f"{BASE_URL}/{endpoint}", json=data or {})

        if response.status_code == 401:
            raise RuntimeError("Ashby API error: API key is missing or invalid")
        elif response.status_code == 403:
            raise RuntimeError("Ashby API error: API key lacks required permissions")

        result = response.json()

        if not result.get("success", True):
            errors = result.get("errors", [])
            msgs = []
            for error in errors:
                msg = error.get("message", str(error)) if isinstance(error, dict) else str(error)
                msgs.append(msg)
            raise RuntimeError(f"Ashby API error: {'; '.join(msgs)}")

        return result

    def _paginate(self, endpoint: str, data: dict | None = None, limit: int = 100) -> list:
        """Fetch results with pagination."""
        data = data or {}
        data["limit"] = min(limit, 100)
        all_results = []
        cursor = None

        while len(all_results) < limit:
            request_data = {**data}
            if cursor:
                request_data["cursor"] = cursor

            result = self._request(endpoint, request_data)
            results = result.get("results", [])
            all_results.extend(results)

            if not result.get("moreDataAvailable", False):
                break

            cursor = result.get("nextCursor")
            if not cursor:
                break

        return all_results[:limit]

    # Jobs
    def jobs(self, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        """List all jobs."""
        jobs = self._paginate("job.list", limit=limit)
        if status:
            jobs = [j for j in jobs if j.get("status", "").lower() == status.lower()]
        return jobs

    def job(self, job_id: str) -> dict[str, Any] | None:
        """Get job details."""
        result = self._request("job.info", {"jobId": job_id})
        return result.get("results")

    # Candidates
    def candidates(self, limit: int = 50) -> list[dict[str, Any]]:
        """List candidates."""
        return self._paginate("candidate.list", limit=limit)

    def candidate(self, candidate_id: str) -> dict[str, Any] | None:
        """Get candidate details."""
        result = self._request("candidate.info", {"id": candidate_id})
        return result.get("results")

    def search_candidates(
        self, query: str, limit: int = 20, by_email: bool = False
    ) -> list[dict[str, Any]]:
        """Search candidates by name or email.

        The Ashby API requires 'name' or 'email' as separate params, not a generic term.
        By default searches by name. Use by_email=True to search by email instead.
        If query looks like an email (contains @), automatically searches by email.
        """
        data: dict[str, Any] = {}

        if by_email or "@" in query:
            data["email"] = query
        else:
            data["name"] = query

        result = self._request("candidate.search", data)
        results = result.get("results", [])
        return results[:limit]

    # Applications
    def applications(self, job_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        """List applications."""
        data = {}
        if job_id:
            data["jobId"] = job_id
        return self._paginate("application.list", data, limit=limit)

    def application(self, application_id: str) -> dict[str, Any] | None:
        """Get application details."""
        result = self._request("application.info", {"applicationId": application_id})
        return result.get("results")

    def application_history(self, application_id: str) -> list[dict[str, Any]]:
        """Get application stage history."""
        result = self._request("application.listHistory", {"applicationId": application_id})
        return result.get("results", [])

    # Interviews
    def interviews(self, limit: int = 50) -> list[dict[str, Any]]:
        """List interviews."""
        return self._paginate("interview.list", limit=limit)

    def interview(self, interview_id: str) -> dict[str, Any] | None:
        """Get interview details."""
        result = self._request("interview.info", {"interviewId": interview_id})
        return result.get("results")

    # Interview Stages
    def stages(self) -> list[dict[str, Any]]:
        """List interview stages."""
        result = self._request("interviewStage.list")
        return result.get("results", [])

    def stage_groups(self) -> list[dict[str, Any]]:
        """List interview stage groups."""
        result = self._request("interviewStageGroup.list")
        return result.get("results", [])

    # Users
    def users(self, limit: int = 100, include_disabled: bool = False) -> list[dict[str, Any]]:
        """List users.

        Args:
            limit: Max results to return
            include_disabled: If True, include disabled/deactivated (former) employees
        """
        payload: dict[str, Any] = {"limit": min(limit, 100)}
        if include_disabled:
            payload["includeDeactivated"] = True
        result = self._request("user.list", payload)
        users = result.get("results", [])
        if not include_disabled:
            users = [u for u in users if u.get("isEnabled", True)]
        return users

    def all_users(self, limit: int = 500) -> list[dict[str, Any]]:
        """List all users including disabled (former employees)."""
        return self.users(limit=limit, include_disabled=True)

    def user(self, user_id: str) -> dict[str, Any] | None:
        """Get user details."""
        result = self._request("user.info", {"userId": user_id})
        return result.get("results")

    def api_key_info(self) -> dict[str, Any]:
        """Get current API key info."""
        result = self._request("apiKey.info")
        return result.get("results", {})

    # Departments
    def departments(self) -> list[dict[str, Any]]:
        """List departments."""
        result = self._request("department.list")
        return result.get("results", [])

    # Sources & Tags
    def sources(self) -> list[dict[str, Any]]:
        """List candidate sources."""
        result = self._request("source.list")
        return result.get("results", [])

    def tags(self) -> list[dict[str, Any]]:
        """List candidate tags."""
        result = self._request("candidateTag.list")
        return result.get("results", [])

    # Files
    def file_url(self, file_handle: str) -> str | None:
        """Get a downloadable URL for a file handle (e.g., resume)."""
        result = self._request("file.info", {"fileHandle": file_handle})
        return result.get("results", {}).get("url")

    def resume_url(self, candidate_id: str) -> str | None:
        """Get the resume URL for a candidate if they have one uploaded."""
        candidate = self.candidate(candidate_id)
        if not candidate:
            return None

        file_handles = candidate.get("fileHandles", [])
        for fh in file_handles:
            fh_type = fh.get("type", "")
            fh_name = fh.get("name", "").lower()
            if fh_type == "Resume" or "resume" in fh_name:
                handle = fh.get("handle")
                if handle:
                    return self.file_url(handle)
        return None

    # Application Feedback / Scorecards
    def application_feedback(
        self, application_id: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        """List application feedback/scorecards."""
        data = {}
        if application_id:
            data["applicationId"] = application_id
        return self._paginate("applicationFeedback.list", data, limit=limit)

    def interview_events(self, limit: int = 100) -> list[dict[str, Any]]:
        """List interview events (scheduled interviews)."""
        return self._paginate("interviewEvent.list", limit=limit)


def _client() -> AshbyClient:
    return AshbyClient()
