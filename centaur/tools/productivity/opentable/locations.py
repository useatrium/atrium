"""OpenTable location ID mappings for metros, regions, and neighborhoods."""

# Zipcode to neighborhood ID mappings
# Maps US zipcodes to OpenTable neighborhoodIds for precise location filtering
ZIPCODES = {
    # San Francisco
    "94102": {
        "name": "Civic Center / Hayes Valley / Tenderloin",
        "ids": [34, 35, 21317],
        "metro_id": 4,
        "region_id": 5,
    },
    "94103": {"name": "SoMa", "ids": [45], "metro_id": 4, "region_id": 5},
    "94104": {"name": "Financial District", "ids": [227], "metro_id": 4, "region_id": 5},
    "94105": {
        "name": "South Beach / Rincon Hill / Embarcadero",
        "ids": [227, 45],
        "metro_id": 4,
        "region_id": 5,
    },
    "94107": {
        "name": "Potrero Hill / Dogpatch / South Beach",
        "ids": [45, 4235, 3287],
        "metro_id": 4,
        "region_id": 5,
    },
    "94108": {"name": "Chinatown / Nob Hill", "ids": [40, 10637], "metro_id": 4, "region_id": 5},
    "94109": {
        "name": "Russian Hill / Polk Gulch / Nob Hill",
        "ids": [641, 40],
        "metro_id": 4,
        "region_id": 5,
    },
    "94110": {"name": "Mission District", "ids": [2951, 39], "metro_id": 4, "region_id": 5},
    "94111": {
        "name": "Embarcadero / Financial District",
        "ids": [227],
        "metro_id": 4,
        "region_id": 5,
    },
    "94112": {"name": "Excelsior / Outer Mission", "ids": [], "metro_id": 4, "region_id": 5},
    "94114": {"name": "Castro / Noe Valley", "ids": [32, 631], "metro_id": 4, "region_id": 5},
    "94115": {
        "name": "Pacific Heights / Japantown",
        "ids": [42, 3029, 693],
        "metro_id": 4,
        "region_id": 5,
    },
    "94116": {"name": "Sunset", "ids": [640], "metro_id": 4, "region_id": 5},
    "94117": {"name": "Haight-Ashbury", "ids": [1382], "metro_id": 4, "region_id": 5},
    "94118": {"name": "Inner Richmond", "ids": [44], "metro_id": 4, "region_id": 5},
    "94121": {"name": "Outer Richmond", "ids": [44], "metro_id": 4, "region_id": 5},
    "94122": {"name": "Inner Sunset", "ids": [640], "metro_id": 4, "region_id": 5},
    "94123": {"name": "Marina / Cow Hollow", "ids": [38, 22615], "metro_id": 4, "region_id": 5},
    "94124": {"name": "Bayview / Hunters Point", "ids": [8285], "metro_id": 4, "region_id": 5},
    "94127": {"name": "West Portal / Forest Hill", "ids": [916], "metro_id": 4, "region_id": 5},
    "94129": {"name": "Presidio", "ids": [38, 674], "metro_id": 4, "region_id": 5},
    "94131": {"name": "Twin Peaks / Glen Park", "ids": [4418], "metro_id": 4, "region_id": 5},
    "94132": {"name": "Lake Merced / Stonestown", "ids": [], "metro_id": 4, "region_id": 5},
    "94133": {"name": "North Beach / Telegraph Hill", "ids": [41], "metro_id": 4, "region_id": 5},
    "94134": {"name": "Visitacion Valley", "ids": [], "metro_id": 4, "region_id": 5},
    "94158": {"name": "Mission Bay", "ids": [4235, 45], "metro_id": 4, "region_id": 5},
    # Manhattan (NYC)
    "10001": {"name": "Chelsea", "ids": [100], "metro_id": 8, "region_id": 52},
    "10002": {"name": "Lower East Side", "ids": [108], "metro_id": 8, "region_id": 52},
    "10003": {"name": "East Village / Gramercy", "ids": [102, 104], "metro_id": 8, "region_id": 52},
    "10004": {"name": "Financial District", "ids": [103], "metro_id": 8, "region_id": 52},
    "10005": {"name": "Financial District", "ids": [103], "metro_id": 8, "region_id": 52},
    "10006": {"name": "Financial District", "ids": [103], "metro_id": 8, "region_id": 52},
    "10007": {"name": "Tribeca", "ids": [111], "metro_id": 8, "region_id": 52},
    "10011": {"name": "Chelsea / West Village", "ids": [100, 114], "metro_id": 8, "region_id": 52},
    "10012": {"name": "SoHo / NoHo", "ids": [110], "metro_id": 8, "region_id": 52},
    "10013": {"name": "Tribeca / SoHo", "ids": [111, 110], "metro_id": 8, "region_id": 52},
    "10014": {
        "name": "West Village / Greenwich Village",
        "ids": [114, 105],
        "metro_id": 8,
        "region_id": 52,
    },
    "10016": {"name": "Gramercy / Murray Hill", "ids": [104], "metro_id": 8, "region_id": 52},
    "10017": {"name": "Midtown East", "ids": [109], "metro_id": 8, "region_id": 52},
    "10018": {"name": "Midtown / Times Square", "ids": [109], "metro_id": 8, "region_id": 52},
    "10019": {
        "name": "Midtown West / Hell's Kitchen",
        "ids": [109, 107],
        "metro_id": 8,
        "region_id": 52,
    },
    "10021": {"name": "Upper East Side", "ids": [112], "metro_id": 8, "region_id": 52},
    "10022": {"name": "Midtown East", "ids": [109], "metro_id": 8, "region_id": 52},
    "10023": {"name": "Upper West Side", "ids": [113], "metro_id": 8, "region_id": 52},
    "10024": {"name": "Upper West Side", "ids": [113], "metro_id": 8, "region_id": 52},
    "10025": {"name": "Upper West Side", "ids": [113], "metro_id": 8, "region_id": 52},
    "10028": {"name": "Upper East Side", "ids": [112], "metro_id": 8, "region_id": 52},
    "10036": {
        "name": "Times Square / Hell's Kitchen",
        "ids": [109, 107],
        "metro_id": 8,
        "region_id": 52,
    },
    "10065": {"name": "Upper East Side", "ids": [112], "metro_id": 8, "region_id": 52},
    "10075": {"name": "Upper East Side", "ids": [112], "metro_id": 8, "region_id": 52},
    "10128": {"name": "Upper East Side", "ids": [112], "metro_id": 8, "region_id": 52},
}

METROS = {
    "sf": {"id": 4, "name": "San Francisco Bay Area"},
    "san_francisco": {"id": 4, "name": "San Francisco Bay Area"},
    "bay_area": {"id": 4, "name": "San Francisco Bay Area"},
    "nyc": {"id": 8, "name": "New York City"},
    "new_york": {"id": 8, "name": "New York City"},
    "la": {"id": 6, "name": "Los Angeles"},
    "los_angeles": {"id": 6, "name": "Los Angeles"},
}

REGIONS = {
    # San Francisco Bay Area (metroId=4)
    4: {
        "all": {"id": None, "name": "All San Francisco Bay Area"},
        "san_francisco": {"id": 5, "name": "San Francisco"},
        "sf": {"id": 5, "name": "San Francisco"},
        "east_bay": {"id": 6, "name": "East Bay"},
        "marin": {"id": 7, "name": "Marin"},
        "peninsula": {"id": 8, "name": "Peninsula"},
        "south_bay": {"id": 9, "name": "San Jose / Silicon Valley"},
        "silicon_valley": {"id": 9, "name": "San Jose / Silicon Valley"},
        "wine_country": {"id": 10, "name": "Wine Country"},
        "santa_cruz": {"id": 11, "name": "Santa Cruz / Capitola / Aptos"},
    },
    # New York City (metroId=8)
    8: {
        "all": {"id": None, "name": "All New York City"},
        "manhattan": {"id": 52, "name": "Manhattan"},
        "brooklyn": {"id": 53, "name": "Brooklyn"},
        "queens": {"id": 54, "name": "Queens"},
        "bronx": {"id": 55, "name": "Bronx"},
        "staten_island": {"id": 56, "name": "Staten Island"},
    },
    # Los Angeles (metroId=6)
    6: {
        "all": {"id": None, "name": "All Los Angeles"},
        "hollywood": {"id": 1048, "name": "Hollywood"},
        "downtown": {"id": 1155, "name": "Downtown"},
        "westside": {"id": 1591, "name": "Westside"},
        "beverly_hills": {"id": 1822, "name": "West Hollywood / Beverly Hills / Mid-Wilshire"},
        "santa_monica": {"id": 1405, "name": "Beach Cities"},
        "pasadena": {"id": 627, "name": "Pasadena"},
        "valley": {"id": 2195, "name": "San Fernando Valley"},
    },
}

NEIGHBORHOODS = {
    # San Francisco (regionId=5)
    5: {
        "bayview": 8285,
        "bernal_heights": 9110,
        "chinatown": 10637,
        "civic_center": 34,
        "hayes_valley": 34,
        "cole_valley": 36,
        "cow_hollow": 22615,
        "downtown": 35,
        "union_square": 35,
        "financial_district": 227,
        "embarcadero": 227,
        "fishermans_wharf": 49,
        "forest_hill": 916,
        "west_portal": 916,
        "glen_park": 4418,
        "haight": 1382,
        "japantown": 693,
        "marina": 38,
        "presidio": 38,
        "mission_bay": 4235,
        "south_beach": 4235,
        "mission": 2951,
        "nob_hill": 40,
        "noe_valley": 631,
        "north_beach": 41,
        "pacific_heights": 42,
        "potrero_hill": 28802,
        "dogpatch": 3287,
        "richmond": 44,
        "russian_hill": 641,
        "soma": 45,
        "sunset": 640,
        "tenderloin": 21317,
        "castro": 32,
        "western_addition": 3029,
    },
    # Manhattan (regionId=52)
    52: {
        "chelsea": 100,
        "chinatown": 101,
        "east_village": 102,
        "financial_district": 103,
        "gramercy": 104,
        "greenwich_village": 105,
        "harlem": 106,
        "hells_kitchen": 107,
        "lower_east_side": 108,
        "midtown": 109,
        "soho": 110,
        "tribeca": 111,
        "upper_east_side": 112,
        "upper_west_side": 113,
        "west_village": 114,
    },
}


def get_metro_id(metro_name: str) -> int | None:
    """Get metro ID from name."""
    key = metro_name.lower().replace(" ", "_").replace("-", "_")
    if key in METROS:
        return METROS[key]["id"]
    return None


def get_region_id(metro_id: int, region_name: str) -> int | None:
    """Get region ID from metro ID and region name."""
    if metro_id not in REGIONS:
        return None
    key = region_name.lower().replace(" ", "_").replace("-", "_")
    if key in REGIONS[metro_id]:
        return REGIONS[metro_id][key]["id"]
    return None


def get_neighborhood_ids(region_id: int, neighborhood_names: list[str]) -> list[int]:
    """Get neighborhood IDs from region ID and neighborhood names."""
    if region_id not in NEIGHBORHOODS:
        return []
    result = []
    for name in neighborhood_names:
        key = name.lower().replace(" ", "_").replace("-", "_").replace("'", "")
        if key in NEIGHBORHOODS[region_id]:
            result.append(NEIGHBORHOODS[region_id][key])
    return result


def list_metros() -> list[dict]:
    """List all available metros."""
    seen = set()
    result = []
    for key, data in METROS.items():
        if data["id"] not in seen:
            seen.add(data["id"])
            result.append({"key": key, "id": data["id"], "name": data["name"]})
    return result


def list_regions(metro_id: int) -> list[dict]:
    """List all regions for a metro."""
    if metro_id not in REGIONS:
        return []
    return [
        {"key": key, "id": data["id"], "name": data["name"]}
        for key, data in REGIONS[metro_id].items()
    ]


def list_neighborhoods(region_id: int) -> list[dict]:
    """List all neighborhoods for a region."""
    if region_id not in NEIGHBORHOODS:
        return []
    return [{"name": key, "id": nid} for key, nid in NEIGHBORHOODS[region_id].items()]


def get_zipcode_info(zipcode: str) -> dict | None:
    """Get neighborhood IDs and metadata for a zipcode.

    Returns dict with keys: name, ids, metro_id, region_id
    Returns None if zipcode is not mapped.
    """
    return ZIPCODES.get(zipcode)


def get_neighborhood_ids_for_zipcode(zipcode: str) -> list[int]:
    """Get neighborhood IDs for a zipcode.

    Returns list of neighborhood IDs, or empty list if not mapped.
    """
    info = ZIPCODES.get(zipcode)
    return info["ids"] if info else []


def list_zipcodes(metro_id: int | None = None) -> list[dict]:
    """List all mapped zipcodes, optionally filtered by metro.

    Returns list of dicts with keys: zipcode, name, ids, metro_id, region_id
    """
    result = []
    for zipcode, info in ZIPCODES.items():
        if metro_id is None or info.get("metro_id") == metro_id:
            result.append({"zipcode": zipcode, **info})
    return sorted(result, key=lambda x: x["zipcode"])
