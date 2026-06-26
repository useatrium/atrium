"""Google News RSS client."""

from urllib.parse import quote_plus

import feedparser


class GoogleNewsClient:
    """Client for Google News RSS feeds."""

    BASE_URL = "https://news.google.com/rss"

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    def _fetch_feed(self, url: str) -> list[dict]:
        """Fetch and parse RSS feed."""
        feed = feedparser.parse(url)
        if feed.bozo and not feed.entries:
            raise RuntimeError(f"Failed to fetch feed: {feed.bozo_exception}")

        articles = []
        for entry in feed.entries:
            articles.append(
                {
                    "title": entry.get("title", ""),
                    "link": entry.get("link", ""),
                    "published": entry.get("published", ""),
                    "source": entry.get("source", {}).get("title", "")
                    if hasattr(entry, "source")
                    else "",
                }
            )
        return articles

    def search(self, query: str, limit: int = 20) -> list[dict]:
        """Search for news articles."""
        encoded_query = quote_plus(query)
        url = f"{self.BASE_URL}/search?q={encoded_query}"
        articles = self._fetch_feed(url)
        return articles[:limit]

    def headlines(self, country: str = "US", limit: int = 20) -> list[dict]:
        """Get top headlines for a country."""
        url = f"{self.BASE_URL}?hl=en-{country}&gl={country}&ceid={country}:en"
        articles = self._fetch_feed(url)
        return articles[:limit]

    def topic(self, topic: str, country: str = "US", limit: int = 20) -> list[dict]:
        """Get news by topic.

        Topics: WORLD, NATION, BUSINESS, TECHNOLOGY, ENTERTAINMENT, SPORTS, SCIENCE, HEALTH
        """
        topic_upper = topic.upper()
        url = f"{self.BASE_URL}/headlines/section/topic/{topic_upper}?hl=en-{country}&gl={country}&ceid={country}:en"
        articles = self._fetch_feed(url)
        return articles[:limit]


def _client() -> GoogleNewsClient:
    """Factory: create a GoogleNewsClient (no credentials needed)."""
    return GoogleNewsClient()
