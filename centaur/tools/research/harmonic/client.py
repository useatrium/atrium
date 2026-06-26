"""Harmonic.AI API client."""


import httpx

from centaur_sdk import secret


def _clean_text(value: str | None) -> str:
    """Normalize text for substring matching and deduplication."""
    if not value:
        return ""
    return " ".join(value.casefold().split())


def _coerce_list(value: object) -> list:
    """Return a list view over a field that may be singular or plural."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _first_non_empty(*values: object) -> str | None:
    """Return the first non-empty string-like value."""
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
            continue
        if isinstance(value, (int, float)):
            return str(value)
    return None


def _extract_url(value: object) -> str | None:
    """Extract a URL from the shapes Harmonic uses for social links."""
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        return _first_non_empty(
            value.get("url"),
            value.get("link"),
            value.get("profile_url"),
            value.get("profileUrl"),
        )
    if isinstance(value, list):
        for item in value:
            url = _extract_url(item)
            if url:
                return url
    return None


def _dedupe_strings(values: list[str]) -> list[str]:
    """Deduplicate strings while preserving order and normalizing whitespace."""
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = _clean_text(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(" ".join(value.split()))
    return deduped


def _company_name(experience: dict | None) -> str | None:
    """Extract a company name from an experience block."""
    if not isinstance(experience, dict):
        return None
    company = experience.get("company")
    if isinstance(company, dict):
        return _first_non_empty(company.get("name"), company.get("display_name"))
    return _first_non_empty(
        experience.get("companyName"),
        experience.get("company_name"),
        experience.get("organizationName"),
    )


def _pick_current_experience(experiences: list[dict]) -> dict | None:
    """Prefer the current experience, then fall back to the first entry."""
    for experience in experiences:
        if not isinstance(experience, dict):
            continue
        if experience.get("is_current") is True or experience.get("isCurrent") is True:
            return experience
        if experience.get("current") is True:
            return experience
        if not experience.get("end_date") and not experience.get("endDate"):
            return experience
    return experiences[0] if experiences else None


def _location_text(location: object) -> str | None:
    """Collapse location objects into a single readable string."""
    if isinstance(location, str):
        return location.strip() or None
    if not isinstance(location, dict):
        return None
    direct = _first_non_empty(
        location.get("display_name"),
        location.get("displayName"),
        location.get("formatted"),
        location.get("name"),
    )
    if direct:
        return direct
    parts = [
        _first_non_empty(location.get("city")),
        _first_non_empty(location.get("region"), location.get("state")),
        _first_non_empty(location.get("country"), location.get("country_name")),
    ]
    return ", ".join(part for part in parts if part) or None


def _education_terms(education: object) -> list[str]:
    """Collect school and degree terms for background matching."""
    terms: list[str] = []
    for entry in _coerce_list(education):
        if not isinstance(entry, dict):
            continue
        school = entry.get("school")
        if isinstance(school, dict):
            school_name = _first_non_empty(school.get("name"), school.get("display_name"))
        else:
            school_name = _first_non_empty(entry.get("schoolName"), entry.get("school_name"))
        degree_name = _first_non_empty(
            entry.get("degree"),
            entry.get("degree_name"),
            entry.get("field_of_study"),
            entry.get("fieldOfStudy"),
        )
        if school_name:
            terms.append(school_name)
        if degree_name:
            terms.append(degree_name)
    return _dedupe_strings(terms)


def _match_query(haystack: object, query: str | None) -> bool:
    """Case-insensitive substring match used by recruiting filters."""
    if not query:
        return True
    if isinstance(haystack, list):
        text = " ".join(str(item) for item in haystack)
    else:
        text = str(haystack or "")
    return _clean_text(query) in _clean_text(text)


def _normalize_seniority(title: str | None) -> str:
    """Map free-form titles onto a small recruiting-friendly seniority set."""
    normalized = _clean_text(title)
    tokens = normalized.split()
    if not normalized:
        return "unknown"
    if "founder" in normalized or "cofounder" in normalized or "co-founder" in normalized:
        return "founder"
    if "chief of staff" in normalized:
        return "director"
    if any(token in tokens for token in ("ceo", "cto", "coo", "cfo", "cmo", "cro", "cio")):
        return "executive"
    if normalized.startswith("chief ") or " president" in normalized or normalized == "president":
        return "executive"
    if any(token in tokens for token in ("svp", "evp")) or "vice president" in normalized or "head of" in normalized:
        return "vp"
    if any(token in normalized for token in ("director", "principal", "staff")):
        return "director"
    if any(token in normalized for token in ("manager", "lead")):
        return "manager"
    return "individual_contributor"


def _clean_secret(value: str | None) -> str | None:
    """Clean a secret value that may come from a multi-line 1Password field."""
    if not value:
        return value
    value = value.strip()
    if "\n" not in value:
        return value or None
    for line in value.splitlines():
        line = line.strip()
        if not line or line.startswith("===") or line.startswith("#"):
            continue
        return line
    return None


class HarmonicClient:
    """Client for Harmonic.AI API."""

    def __init__(self, api_key: str | None = None, timeout: float = 60.0):
        self._api_key = _clean_secret(api_key)
        self.base_url = "https://api.harmonic.ai"
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
        return _clean_secret(secret("HARMONIC_API_KEY", ""))

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
            raise RuntimeError("HARMONIC_API_KEY not set.")

        url = f"{self.base_url}{endpoint}"
        headers = {"apikey": api_key, "Content-Type": "application/json"}

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
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}") from e
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}") from e

    def enrich_company(
        self,
        website_url: str | None = None,
        website_domain: str | None = None,
        linkedin_url: str | None = None,
        crunchbase_url: str | None = None,
        pitchbook_url: str | None = None,
        twitter_url: str | None = None,
    ) -> dict:
        """Enrich a company by passing one or more identifiers."""
        params = {}
        if website_url:
            params["website_url"] = website_url
        if website_domain:
            params["website_domain"] = website_domain
        if linkedin_url:
            params["linkedin_url"] = linkedin_url
        if crunchbase_url:
            params["crunchbase_url"] = crunchbase_url
        if pitchbook_url:
            params["pitchbook_url"] = pitchbook_url
        if twitter_url:
            params["twitter_url"] = twitter_url

        if not params:
            raise ValueError("At least one identifier is required")

        return self._request("POST", "/companies", params=params)

    def enrich_person(self, linkedin_url: str) -> dict:
        """Enrich a person by LinkedIn URL."""
        return self._request("POST", "/persons", params={"linkedin_url": linkedin_url})

    def get_enrichment_status(
        self,
        ids: list[str] | None = None,
        urns: list[str] | None = None,
    ) -> dict:
        """Get enrichment status for given IDs or URNs."""
        params = {}
        if ids:
            params["ids"] = ",".join(ids)
        if urns:
            params["urns"] = ",".join(urns)
        return self._request("GET", "/enrichment_status", params=params)

    def get_saved_searches(self) -> dict:
        """Get all saved searches accessible to your account."""
        return self._request("GET", "/savedSearches")

    def _list_saved_searches(self) -> list[dict]:
        """Normalize the saved-search listing response into a list."""
        data = self.get_saved_searches()
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict):
            results = data.get("results") or data.get("savedSearches") or []
            return [item for item in results if isinstance(item, dict)]
        return []

    def _resolve_people_saved_search(self, saved_search_name: str) -> dict:
        """Resolve a people saved search by exact or unique partial name."""
        target = _clean_text(saved_search_name)
        if not target:
            raise ValueError("saved_search_name must not be empty")

        searches = [
            search
            for search in self._list_saved_searches()
            if "people" in _clean_text(
                _first_non_empty(str(search.get("type") or ""), str(search.get("entityType") or ""))
            )
            or "person" in _clean_text(
                _first_non_empty(str(search.get("type") or ""), str(search.get("entityType") or ""))
            )
        ]
        exact = [search for search in searches if _clean_text(str(search.get("name") or "")) == target]
        if len(exact) == 1:
            return exact[0]

        partial = [search for search in searches if target in _clean_text(str(search.get("name") or ""))]
        if len(partial) == 1:
            return partial[0]
        if exact or partial:
            raise RuntimeError(
                "Multiple people saved searches matched that name. Pass saved_search_id_or_urn instead."
            )
        raise RuntimeError(f"No people saved search matched '{saved_search_name}'.")

    def _normalize_person_result(self, person: dict) -> dict:
        """Normalize people saved-search results into recruiting-friendly fields."""
        experiences = [entry for entry in _coerce_list(person.get("experience") or person.get("experiences")) if isinstance(entry, dict)]
        current_experience = _pick_current_experience(experiences)
        current_title = _first_non_empty(
            current_experience.get("title") if current_experience else None,
            current_experience.get("role") if current_experience else None,
            person.get("title"),
            person.get("linkedin_headline"),
            person.get("linkedinHeadline"),
            person.get("headline"),
        )
        current_company = _company_name(current_experience)
        prior_employers = _dedupe_strings(
            [
                company_name
                for experience in experiences
                if experience is not current_experience
                for company_name in [_company_name(experience)]
                if company_name
            ]
        )
        socials = person.get("socials") if isinstance(person.get("socials"), dict) else {}
        profile_urls = {
            "linkedin": _extract_url(
                socials.get("linkedin") if isinstance(socials, dict) else None
            )
            or _first_non_empty(person.get("linkedin_url"), person.get("linkedinUrl")),
            "twitter": _extract_url(
                (socials.get("twitter") if isinstance(socials, dict) else None)
                or (socials.get("x") if isinstance(socials, dict) else None)
            ),
            "github": _extract_url(socials.get("github") if isinstance(socials, dict) else None),
            "website": _extract_url(
                (socials.get("website") if isinstance(socials, dict) else None)
                or (socials.get("personal_website") if isinstance(socials, dict) else None)
            ),
        }

        normalized = {
            "full_name": _first_non_empty(
                person.get("full_name"),
                person.get("fullName"),
                " ".join(
                    part
                    for part in [
                        _first_non_empty(person.get("first_name"), person.get("firstName")),
                        _first_non_empty(person.get("last_name"), person.get("lastName")),
                    ]
                    if part
                ),
            ),
            "current_title": current_title,
            "current_company": current_company,
            "headline": _first_non_empty(
                person.get("linkedin_headline"),
                person.get("linkedinHeadline"),
                person.get("headline"),
            ),
            "seniority": _normalize_seniority(current_title),
            "location": _location_text(person.get("location")),
            "prior_employers": prior_employers,
            "education": _education_terms(person.get("education")),
            "profile_urls": {key: value for key, value in profile_urls.items() if value},
            "entity_urn": _first_non_empty(person.get("entity_urn"), person.get("entityUrn")),
        }
        return normalized

    def search_people_recruiting(
        self,
        saved_search_id_or_urn: str | None = None,
        saved_search_name: str | None = None,
        role_query: str | None = None,
        background_query: str | None = None,
        prior_employers: list[str] | None = None,
        seniority: list[str] | None = None,
        locations: list[str] | None = None,
        size: int = 25,
        cursor: str | None = None,
    ) -> dict:
        """Search people saved-search results with recruiting-friendly filters and normalized output."""
        if not saved_search_id_or_urn and not saved_search_name:
            raise ValueError("Pass saved_search_id_or_urn or saved_search_name")

        saved_search: dict | None = None
        search_id_or_urn = saved_search_id_or_urn
        if not search_id_or_urn:
            saved_search = self._resolve_people_saved_search(saved_search_name or "")
            search_id_or_urn = _first_non_empty(
                saved_search.get("entity_urn"),
                saved_search.get("urn"),
                saved_search.get("id"),
            )
            if not search_id_or_urn:
                raise RuntimeError("Matched people saved search is missing an ID or URN.")

        data = self.get_saved_search_results(search_id_or_urn, cursor=cursor, size=size)
        raw_results = data.get("results") or []
        normalized_results = [
            self._normalize_person_result(person)
            for person in raw_results
            if isinstance(person, dict)
        ]

        allowed_seniority = {_clean_text(level) for level in seniority or [] if _clean_text(level)}
        location_filters = [location for location in locations or [] if _clean_text(location)]
        employer_filters = [employer for employer in prior_employers or [] if _clean_text(employer)]

        filtered_results: list[dict] = []
        for person in normalized_results:
            role_text = " ".join(filter(None, [person.get("current_title"), person.get("headline")]))
            background_text = " ".join(
                filter(
                    None,
                    [
                        person.get("current_company"),
                        role_text,
                        person.get("location"),
                        " ".join(person.get("prior_employers") or []),
                        " ".join(person.get("education") or []),
                    ],
                )
            )

            if not _match_query(role_text, role_query):
                continue
            if not _match_query(background_text, background_query):
                continue
            if employer_filters and not any(
                _match_query(person.get("prior_employers") or [], employer) for employer in employer_filters
            ):
                continue
            if allowed_seniority and _clean_text(str(person.get("seniority") or "")) not in allowed_seniority:
                continue
            if location_filters and not any(
                _match_query(person.get("location"), location) for location in location_filters
            ):
                continue
            filtered_results.append(person)

        return {
            "saved_search": {
                "id_or_urn": search_id_or_urn,
                "name": saved_search.get("name") if saved_search else None,
                "type": saved_search.get("type") if saved_search else None,
            },
            "applied_filters": {
                "role_query": role_query,
                "background_query": background_query,
                "prior_employers": prior_employers or [],
                "seniority": seniority or [],
                "locations": locations or [],
            },
            "count": len(filtered_results),
            "source_count": data.get("count") or len(normalized_results),
            "page_info": data.get("page_info") or {},
            "results": filtered_results,
        }

    def get_saved_search_results(
        self,
        id_or_urn: str,
        cursor: str | None = None,
        size: int = 50,
    ) -> dict:
        """Get results from a saved search."""
        params = {"size": size}
        if cursor:
            params["cursor"] = cursor
        return self._request("GET", f"/savedSearches:results/{id_or_urn}", params=params)

    def get_saved_search_net_new(
        self,
        id_or_urn: str,
        new_results_since: str | None = None,
        cursor: str | None = None,
        size: int = 50,
    ) -> dict:
        """Get net new results for a subscribed saved search."""
        params = {"size": size}
        if new_results_since:
            params["new_results_since"] = new_results_since
        if cursor:
            params["cursor"] = cursor
        return self._request("GET", f"/savedSearches:netNewResults/{id_or_urn}", params=params)

    def clear_net_new_results(self, id_or_urn: str) -> dict:
        """Clear net new results for a saved search."""
        return self._request("POST", f"/savedSearches:netNewResults/{id_or_urn}:clear")

    def search_companies_natural_language(
        self,
        query: str,
        size: int = 25,
        cursor: str | None = None,
        similarity_threshold: float | None = None,
    ) -> dict:
        """Search companies using natural language (Scout Search)."""
        params = {"query": query, "size": size}
        if cursor:
            params["cursor"] = cursor
        if similarity_threshold is not None:
            params["similarity_threshold"] = similarity_threshold
        return self._request("GET", "/search/search_agent", params=params)

    def get_similar_companies(
        self,
        company_id: str | int,
        size: int = 25,
    ) -> dict:
        """Get companies similar to a given company."""
        params = {"size": size}
        return self._request("GET", f"/search/similar_companies/{company_id}", params=params)

    def search_typeahead(
        self,
        query: str,
        search_type: str = "COMPANY",
    ) -> dict:
        """Typeahead search for companies, people, or investors."""
        params = {"query": query, "search_type": search_type}
        return self._request("GET", "/search/typeahead", params=params)

    def get_company_connections(self, company_id: str | int) -> dict:
        """Get team network connections to a company."""
        return self._request("GET", f"/companies/{company_id}/userConnections")

    def create_saved_search(self, name: str, keywords: str) -> dict:
        """Create a new saved search."""
        body = {"name": name, "keywords": keywords}
        return self._request("POST", "/savedSearches", json_body=body)

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


def _client() -> HarmonicClient:
    # Seed the client with the secret placeholder at load time so the firewall
    # can replace it in-flight, matching the pattern used by other proxy-backed tools.
    return HarmonicClient(api_key=secret("HARMONIC_API_KEY", ""))
