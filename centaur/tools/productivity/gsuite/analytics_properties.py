"""GA4 property ID mappings for known sites."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from google.oauth2.credentials import Credentials

# Mapping of site names/aliases to GA4 property IDs
PROPERTY_MAPPINGS: dict[str, str] = {
    # paradigm.xyz
    "paradigm.xyz": "266994435",
    "paradigm": "266994435",
    "main": "266994435",
    # predictions.paradigm.xyz
    "predictions.paradigm.xyz": "520074175",
    "predictions": "520074175",
}

# Cache for dynamically discovered properties
_dynamic_cache: dict[str, str] = {}


def get_property_id_for_site(site: str, credentials: "Credentials | None" = None) -> str | None:
    """Get property ID for a site name or alias.

    First checks static mappings, then tries to discover dynamically via Admin API.

    Args:
        site: Site name or alias (e.g., 'paradigm.xyz', 'predictions')
        credentials: Optional Google credentials for dynamic lookup

    Returns:
        Property ID if found, None otherwise
    """
    # Normalize: lowercase and strip whitespace
    site_normalized = site.lower().strip()

    # Direct lookup in static mappings
    if site_normalized in PROPERTY_MAPPINGS:
        return PROPERTY_MAPPINGS[site_normalized]

    # Try with/without www
    site_alt = (
        site_normalized[4:] if site_normalized.startswith("www.") else f"www.{site_normalized}"
    )
    if site_alt in PROPERTY_MAPPINGS:
        return PROPERTY_MAPPINGS[site_alt]

    # Check dynamic cache
    if site_normalized in _dynamic_cache:
        return _dynamic_cache[site_normalized]

    # Try dynamic discovery if we have credentials
    if credentials:
        prop_id = _discover_property_for_domain(site_normalized, credentials)
        if prop_id:
            _dynamic_cache[site_normalized] = prop_id
            return prop_id

    return None


def _discover_property_for_domain(domain: str, credentials: "Credentials") -> str | None:
    """Discover GA4 property ID for a domain using the Admin API.

    Args:
        domain: The domain to search for (e.g., 'example.com')
        credentials: Google credentials with analytics.readonly scope

    Returns:
        Property ID if found, None otherwise
    """
    try:
        from google.analytics.admin_v1beta import AnalyticsAdminServiceClient
        from google.analytics.admin_v1beta.types import ListAccountSummariesRequest

        client = AnalyticsAdminServiceClient(credentials=credentials)

        # List all account summaries (includes properties)
        request = ListAccountSummariesRequest()
        summaries = client.list_account_summaries(request=request)

        # Normalize domain for matching
        domain_clean = domain.lower().strip()
        if domain_clean.startswith("http://"):
            domain_clean = domain_clean[7:]
        if domain_clean.startswith("https://"):
            domain_clean = domain_clean[8:]
        if domain_clean.startswith("www."):
            domain_clean = domain_clean[4:]
        domain_clean = domain_clean.rstrip("/")

        # Search through all properties
        for account_summary in summaries:
            for property_summary in account_summary.property_summaries:
                # Property display name often contains the domain
                display_name = property_summary.display_name.lower()

                # Check if domain matches display name
                if domain_clean in display_name or display_name in domain_clean:
                    # Extract property ID from resource name (e.g., "properties/123456789")
                    prop_id = property_summary.property.split("/")[-1]
                    return prop_id

        # If no match by display name, try fetching data streams for each property
        for account_summary in summaries:
            for property_summary in account_summary.property_summaries:
                prop_id = property_summary.property.split("/")[-1]
                try:
                    streams = client.list_data_streams(parent=property_summary.property)
                    for stream in streams:
                        if hasattr(stream, "web_stream_data") and stream.web_stream_data:
                            stream_uri = stream.web_stream_data.default_uri.lower()
                            if domain_clean in stream_uri:
                                return prop_id
                except Exception:
                    # Skip properties we can't access
                    continue

        return None
    except Exception:
        # If Admin API fails, return None and fall back to manual entry
        return None


def list_sites() -> dict[str, str]:
    """Return unique sites and their property IDs.

    Returns:
        Dict mapping canonical site names to property IDs
    """
    # Get unique property IDs with their canonical names (longest name)
    by_property: dict[str, list[str]] = {}
    for name, prop_id in PROPERTY_MAPPINGS.items():
        by_property.setdefault(prop_id, []).append(name)

    # Use the longest name as canonical (usually the full domain)
    return {max(names, key=len): prop_id for prop_id, names in by_property.items()}
