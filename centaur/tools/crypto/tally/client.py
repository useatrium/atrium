"""Tally GraphQL API client."""


import httpx

from centaur_sdk import secret


class TallyClient:
    """Client for Tally on-chain governance API.

    Wraps the Tally GraphQL API for querying governance proposals,
    delegates, and organizations. Requires an API key.
    """

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key or secret("TALLY_API_KEY", "")
        if not self._api_key:
            raise RuntimeError("TALLY_API_KEY not set.")
        self.base_url = "https://api.tally.xyz/query"
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _query(self, query: str, variables: dict | None = None) -> dict:
        """Execute a GraphQL query."""
        headers = {"Api-Key": self._api_key, "Content-Type": "application/json"}
        payload = {"query": query}
        if variables:
            payload["variables"] = variables
        response = self.client.post(self.base_url, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()
        if "errors" in data:
            raise RuntimeError(f"GraphQL error: {data['errors']}")
        return data.get("data", {})

    def list_organizations(self, limit: int = 20) -> list[dict]:
        """List governance organizations.

        Args:
            limit: Maximum number of organizations to return

        Returns:
            List of organization dicts
        """
        query = """
        query Organizations($input: OrganizationsInput!) {
            organizations(input: $input) {
                nodes {
                    id
                    name
                    slug
                    chainIds
                    governorIds
                    proposalsCount
                    delegatesCount
                    tokenOwnersCount
                }
            }
        }
        """
        variables = {"input": {"page": {"limit": limit}}}
        data = self._query(query, variables)
        return data.get("organizations", {}).get("nodes", [])

    def get_organization(self, slug: str) -> dict:
        """Get a single organization by slug.

        Args:
            slug: Organization slug (e.g., "uniswap")

        Returns:
            Organization dict
        """
        query = """
        query Organization($input: OrganizationInput!) {
            organization(input: $input) {
                id
                name
                slug
                chainIds
                governorIds
                proposalsCount
                delegatesCount
                tokenOwnersCount
            }
        }
        """
        variables = {"input": {"slug": slug}}
        data = self._query(query, variables)
        return data.get("organization", {})

    def list_governors(
        self, organization_slug: str | None = None, limit: int = 20
    ) -> list[dict]:
        """List governors, optionally filtered by organization.

        Args:
            organization_slug: Optional organization slug to filter by
            limit: Maximum number of governors to return

        Returns:
            List of governor dicts
        """
        query = """
        query Governors($input: GovernorsInput!) {
            governors(input: $input) {
                nodes {
                    id
                    name
                    slug
                    chainId
                    proposalCount
                    organization {
                        name
                        slug
                    }
                }
            }
        }
        """
        input_vars: dict = {"page": {"limit": limit}}
        if organization_slug:
            input_vars["organizationSlug"] = organization_slug
        variables = {"input": input_vars}
        data = self._query(query, variables)
        return data.get("governors", {}).get("nodes", [])

    def list_proposals(
        self,
        governor_id: str | None = None,
        organization_slug: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        """List governance proposals.

        Args:
            governor_id: Optional governor ID to filter by
            organization_slug: Optional organization slug to filter by
            limit: Maximum number of proposals to return

        Returns:
            List of proposal dicts
        """
        query = """
        query Proposals($input: ProposalsInput!) {
            proposals(input: $input) {
                nodes {
                    id
                    onchainId
                    status
                    metadata {
                        title
                        description
                    }
                    voteStats {
                        votesCount
                        votersCount
                        type
                        percent
                    }
                    start {
                        timestamp
                    }
                    end {
                        timestamp
                    }
                    governor {
                        name
                    }
                    organization {
                        name
                    }
                }
            }
        }
        """
        input_vars: dict = {"page": {"limit": limit}}
        if governor_id:
            input_vars["governorId"] = governor_id
        if organization_slug:
            input_vars["organizationSlug"] = organization_slug
        variables = {"input": input_vars}
        data = self._query(query, variables)
        return data.get("proposals", {}).get("nodes", [])

    def get_proposal(self, proposal_id: str) -> dict:
        """Get a single proposal by ID.

        Args:
            proposal_id: Proposal ID

        Returns:
            Proposal dict
        """
        query = """
        query Proposal($input: ProposalInput!) {
            proposal(input: $input) {
                id
                onchainId
                status
                metadata {
                    title
                    description
                }
                voteStats {
                    votesCount
                    votersCount
                    type
                    percent
                }
                start {
                    timestamp
                }
                end {
                    timestamp
                }
                governor {
                    name
                }
                organization {
                    name
                }
            }
        }
        """
        variables = {"input": {"id": proposal_id}}
        data = self._query(query, variables)
        return data.get("proposal", {})

    def list_delegates(
        self, organization_slug: str, limit: int = 20, sort_by: str = "votes"
    ) -> list[dict]:
        """List delegates for an organization.

        Args:
            organization_slug: Organization slug (e.g., "uniswap")
            limit: Maximum number of delegates to return
            sort_by: Sort field ("votes" or "delegators")

        Returns:
            List of delegate dicts
        """
        query = """
        query Delegates($input: DelegatesInput!) {
            delegates(input: $input) {
                nodes {
                    id
                    account {
                        address
                        name
                        ens
                    }
                    votesCount
                    delegatorsCount
                    organization {
                        name
                    }
                }
            }
        }
        """
        sort_map = {
            "votes": "VOTES",
            "delegators": "DELEGATORS",
        }
        variables = {
            "input": {
                "organizationSlug": organization_slug,
                "page": {"limit": limit},
                "sort": {"sortBy": sort_map.get(sort_by, "VOTES"), "isDescending": True},
            }
        }
        data = self._query(query, variables)
        return data.get("delegates", {}).get("nodes", [])

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> TallyClient:
    return TallyClient()
