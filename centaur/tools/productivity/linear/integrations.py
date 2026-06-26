"""Cross-platform integrations for Linear issues."""

import os
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from centaur_sdk import secret


def _get_gh_token() -> str | None:
    """Get GitHub token from gh CLI."""
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.SubprocessError, FileNotFoundError):
        pass
    return None


class GitHubClient:
    """Simple GitHub API client for searching PRs and commits."""

    def __init__(self, token: str | None = None):
        self.token = token or secret("GITHUB_TOKEN", "") or _get_gh_token()
        headers = {"Accept": "application/vnd.github+json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        self._http = httpx.Client(
            base_url="https://api.github.com",
            headers=headers,
            timeout=10.0,
        )

    def search_prs(
        self, query: str, org: str | None = None, limit: int = 5
    ) -> list[dict[str, Any]]:
        """Search for PRs matching query."""
        search_query = query
        if org:
            search_query = f"org:{org} {query}"
        search_query += " is:pr"

        try:
            resp = self._http.get(
                "/search/issues",
                params={"q": search_query, "per_page": limit, "sort": "updated"},
            )
            resp.raise_for_status()
            items = resp.json().get("items", [])
            return [
                {
                    "title": item.get("title", ""),
                    "url": item.get("html_url", ""),
                    "state": item.get("state", ""),
                    "number": item.get("number"),
                    "repo": item.get("repository_url", "").split("/")[-1]
                    if item.get("repository_url")
                    else "",
                }
                for item in items
            ]
        except Exception:
            return []

    def search_commits(
        self, query: str, org: str | None = None, limit: int = 3
    ) -> list[dict[str, Any]]:
        """Search for commits matching query."""
        search_query = query
        if org:
            search_query = f"org:{org} {query}"

        try:
            resp = self._http.get(
                "/search/commits",
                params={"q": search_query, "per_page": limit, "sort": "committer-date"},
                headers={"Accept": "application/vnd.github.cloak-preview+json"},
            )
            resp.raise_for_status()
            items = resp.json().get("items", [])
            return [
                {
                    "message": item.get("commit", {}).get("message", "").split("\n")[0],
                    "url": item.get("html_url", ""),
                    "sha": item.get("sha", "")[:7],
                    "repo": item.get("repository", {}).get("name", ""),
                }
                for item in items
            ]
        except Exception:
            return []


class SlackSearchClient:
    """Wrapper for Slack search using Slack SDK directly."""

    def __init__(self):
        self._client = None
        self._available = None

    def _get_client(self):
        if self._client is not None:
            return self._client

        token = secret("SLACK_BOT_TOKEN", "")
        if not token:
            return None

        try:
            from slack_sdk import WebClient

            self._client = WebClient(token=token)
            return self._client
        except ImportError:
            return None

    def search(self, query: str, limit: int = 3) -> list[dict[str, Any]]:
        """Search Slack for messages matching query."""
        client = self._get_client()
        if not client:
            return []

        try:
            response = client.search_messages(query=query, count=limit, sort="timestamp")
            messages = []
            for match in response.get("messages", {}).get("matches", []):
                messages.append(
                    {
                        "channel": match.get("channel", {}).get("name", ""),
                        "user": match.get("username", ""),
                        "text": match.get("text", "")[:150],
                        "permalink": match.get("permalink", ""),
                    }
                )
            return messages
        except Exception:
            return []


class LinearEnricher:
    """Enrich Linear issues with links from Slack and GitHub."""

    def __init__(
        self,
        github_org: str = "",
        github_token: str | None = None,
    ):
        self.github = GitHubClient(token=github_token)
        self.slack = SlackSearchClient()
        self.github_org = github_org

    def _extract_search_terms(self, issue: dict[str, Any]) -> list[str]:
        """Extract meaningful search terms from an issue."""
        terms = []

        # Issue identifier (e.g., CHAIN-123)
        identifier = issue.get("identifier", "")
        if identifier:
            terms.append(identifier)

        # Extract key words from title
        title = issue.get("title", "")
        if title:
            # Remove common words, keep meaningful ones
            words = re.findall(r"\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b", title)
            stop_words = {
                "this",
                "that",
                "with",
                "from",
                "have",
                "been",
                "will",
                "should",
                "could",
                "would",
            }
            meaningful = [w for w in words if w.lower() not in stop_words][:3]
            if meaningful:
                terms.append(" ".join(meaningful))

        return terms

    def enrich_issue(self, issue: dict[str, Any]) -> dict[str, Any]:
        """Add Slack and GitHub links to an issue."""
        search_terms = self._extract_search_terms(issue)
        enriched = dict(issue)
        enriched["slack_link"] = None
        enriched["github_link"] = None

        for term in search_terms:
            # Find Slack link
            if not enriched["slack_link"]:
                slack_results = self.slack.search(term, limit=1)
                if slack_results:
                    enriched["slack_link"] = slack_results[0]

            # Find GitHub link (PR preferred, then commit)
            if not enriched["github_link"]:
                pr_results = self.github.search_prs(term, org=self.github_org, limit=1)
                if pr_results:
                    enriched["github_link"] = {"type": "pr", **pr_results[0]}
                else:
                    commit_results = self.github.search_commits(term, org=self.github_org, limit=1)
                    if commit_results:
                        enriched["github_link"] = {"type": "commit", **commit_results[0]}

            # Stop if we found both
            if enriched["slack_link"] and enriched["github_link"]:
                break

        return enriched

    def enrich_issues(self, issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Enrich multiple issues with external links."""
        return [self.enrich_issue(issue) for issue in issues]


def get_last_week_issues(
    team_key: str | None = None,
    state: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Get issues updated in the last week."""
    from .client import LinearClient

    client = LinearClient()
    issues = client.issues(team_key=team_key, state=state, limit=limit)

    # Filter to last week
    one_week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    recent = []
    for issue in issues:
        updated = issue.get("updatedAt", "")
        if updated:
            try:
                updated_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                if updated_dt >= one_week_ago:
                    recent.append(issue)
            except (ValueError, TypeError):
                pass

    return recent


def weekly_report(
    team_key: str | None = None,
    github_org: str = "",
    limit: int = 30,
) -> list[dict[str, Any]]:
    """Generate a weekly report with enriched issues.

    Returns issues from the last week with Slack and GitHub links.
    """
    issues = get_last_week_issues(team_key=team_key, limit=limit)
    enricher = LinearEnricher(github_org=github_org)
    return enricher.enrich_issues(issues)
