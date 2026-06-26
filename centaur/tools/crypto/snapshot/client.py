"""Snapshot GraphQL API client."""


import httpx

from centaur_sdk import secret


class SnapshotClient:
    """Client for Snapshot GraphQL API.

    Wraps the Snapshot Hub GraphQL API for governance voting, proposals, and spaces.
    No API key required for basic usage (60 req/min).
    """

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.base_url = "https://hub.snapshot.org/graphql"
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            headers = {}
            api_key = self._get_api_key()
            if api_key:
                headers["x-api-key"] = api_key
            self._client = httpx.Client(timeout=self.timeout, headers=headers)
        return self._client

    def _get_api_key(self) -> str | None:
        """Get API key from instance or env var."""
        if self._api_key:
            return self._api_key
        return secret("SNAPSHOT_API_KEY", "")

    def _query(self, query: str, variables: dict | None = None) -> dict:
        """Execute a GraphQL query."""
        payload = {"query": query}
        if variables:
            payload["variables"] = variables
        response = self.client.post(self.base_url, json=payload)
        response.raise_for_status()
        data = response.json()
        if "errors" in data:
            raise RuntimeError(f"GraphQL error: {data['errors']}")
        return data.get("data", {})

    def get_space(self, space_id: str) -> dict:
        """Get details for a single Snapshot space.

        Args:
            space_id: Space ID (e.g., "aave.eth")

        Returns:
            Space data dict
        """
        query = """
        query Space($id: String!) {
            space(id: $id) {
                id
                name
                about
                network
                symbol
                members
                admins
                strategies {
                    name
                    network
                    params
                }
                proposalsCount
                followersCount
            }
        }
        """
        data = self._query(query, {"id": space_id})
        return data.get("space", {})

    def list_spaces(
        self,
        first: int = 20,
        order_by: str = "created",
        order_direction: str = "desc",
    ) -> list[dict]:
        """List Snapshot spaces.

        Args:
            first: Number of spaces to return
            order_by: Field to order by
            order_direction: Order direction (asc/desc)

        Returns:
            List of space dicts
        """
        query = """
        query Spaces($first: Int!, $orderBy: String!, $orderDirection: OrderDirection!) {
            spaces(first: $first, orderBy: $orderBy, orderDirection: $orderDirection) {
                id
                name
                about
                network
                symbol
                proposalsCount
                followersCount
            }
        }
        """
        data = self._query(query, {
            "first": first,
            "orderBy": order_by,
            "orderDirection": order_direction,
        })
        return data.get("spaces", [])

    def get_proposal(self, proposal_id: str) -> dict:
        """Get a proposal by ID.

        Args:
            proposal_id: Proposal ID

        Returns:
            Proposal data dict
        """
        query = """
        query Proposal($id: String!) {
            proposal(id: $id) {
                id
                title
                body
                choices
                start
                end
                snapshot
                state
                author
                scores
                scores_total
                votes
                space {
                    id
                    name
                }
            }
        }
        """
        data = self._query(query, {"id": proposal_id})
        return data.get("proposal", {})

    def list_proposals(
        self,
        space: str,
        state: str | None = None,
        first: int = 20,
    ) -> list[dict]:
        """List proposals for a space.

        Args:
            space: Space ID (e.g., "aave.eth")
            state: Optional state filter ("active", "closed", "pending")
            first: Number of proposals to return

        Returns:
            List of proposal dicts
        """
        query = """
        query Proposals($space: String!, $state: String, $first: Int!) {
            proposals(
                first: $first
                where: { space: $space, state: $state }
                orderBy: "created"
                orderDirection: desc
            ) {
                id
                title
                choices
                start
                end
                state
                author
                scores
                scores_total
                votes
                space {
                    id
                    name
                }
            }
        }
        """
        variables: dict = {"space": space, "first": first}
        if state:
            variables["state"] = state
        data = self._query(query, variables)
        return data.get("proposals", [])

    def get_votes(self, proposal_id: str, first: int = 1000) -> list[dict]:
        """Get votes for a proposal.

        Args:
            proposal_id: Proposal ID
            first: Number of votes to return

        Returns:
            List of vote dicts
        """
        query = """
        query Votes($proposal: String!, $first: Int!) {
            votes(
                first: $first
                where: { proposal: $proposal }
                orderBy: "vp"
                orderDirection: desc
            ) {
                id
                voter
                vp
                choice
                created
                space {
                    id
                }
            }
        }
        """
        data = self._query(query, {"proposal": proposal_id, "first": first})
        return data.get("votes", [])

    def get_voting_power(self, voter: str, space: str, proposal: str) -> dict:
        """Get voting power for a voter in a space/proposal context.

        Args:
            voter: Voter address
            space: Space ID
            proposal: Proposal ID

        Returns:
            Voting power data dict
        """
        query = """
        query VotingPower($voter: String!, $space: String!, $proposal: String!) {
            vp(voter: $voter, space: $space, proposal: $proposal) {
                vp
                vp_by_strategy
                vp_state
            }
        }
        """
        data = self._query(query, {
            "voter": voter,
            "space": space,
            "proposal": proposal,
        })
        return data.get("vp", {})

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> SnapshotClient:
    api_key = secret("SNAPSHOT_API_KEY", "")
    return SnapshotClient(api_key=api_key)
