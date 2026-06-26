"""OpenTable client."""

from . import locations
from .scraper import search_sync


class OpenTableClient:
    """Client for OpenTable restaurant search and location lookups."""

    def search(
        self,
        term: str = "",
        covers: int = 2,
        date_time: str | None = None,
        metro_id: int = 4,
        region_ids: list[int] | None = None,
        neighborhood_ids: list[int] | None = None,
        sort_by: str = "rating",
        limit: int = 10,
    ) -> list[dict]:
        """Search for available restaurant reservations."""
        return search_sync(
            term=term,
            covers=covers,
            date_time=date_time,
            metro_id=metro_id,
            region_ids=region_ids,
            neighborhood_ids=neighborhood_ids,
            sort_by=sort_by,
            limit=limit,
        )

    def list_metros(self) -> list[dict]:
        """List all available metro areas."""
        return locations.list_metros()

    def list_regions(self, metro_id: int) -> list[dict]:
        """List all regions for a metro."""
        return locations.list_regions(metro_id)

    def list_neighborhoods(self, region_id: int) -> list[dict]:
        """List all neighborhoods for a region."""
        return locations.list_neighborhoods(region_id)

    def list_zipcodes(self, metro_id: int | None = None) -> list[dict]:
        """List all mapped zipcodes, optionally filtered by metro."""
        return locations.list_zipcodes(metro_id)

    def get_metro_id(self, metro_name: str) -> int | None:
        """Get metro ID from name."""
        return locations.get_metro_id(metro_name)

    def get_region_id(self, metro_id: int, region_name: str) -> int | None:
        """Get region ID from metro ID and region name."""
        return locations.get_region_id(metro_id, region_name)

    def get_neighborhood_ids(self, region_id: int, neighborhood_names: list[str]) -> list[int]:
        """Get neighborhood IDs from region ID and neighborhood names."""
        return locations.get_neighborhood_ids(region_id, neighborhood_names)

    def get_zipcode_info(self, zipcode: str) -> dict | None:
        """Get neighborhood IDs and metadata for a zipcode."""
        return locations.get_zipcode_info(zipcode)


def _client() -> OpenTableClient:
    return OpenTableClient()
