from __future__ import annotations

from coindesk.client import CoinDeskClient


def test_json_fallback_parses_articles() -> None:
    client = CoinDeskClient()

    articles = client._parse_json_or_html_articles(
        '{"articles":[{"headline":"Bitcoin rallies","url":"https://www.coindesk.com/markets/2026/bitcoin","description":"Move higher"}]}'
    )

    assert articles == [
        {
            "title": "Bitcoin rallies",
            "link": "https://www.coindesk.com/markets/2026/bitcoin",
            "published": "",
            "summary": "Move higher",
            "author": "",
            "tags": [],
        }
    ]


def test_html_fallback_parses_article_links() -> None:
    client = CoinDeskClient()

    articles = client._parse_json_or_html_articles(
        '<html><body><a href="/markets/2026/05/bitcoin"> Bitcoin&nbsp;rallies </a></body></html>'
    )

    assert articles == [
        {
            "title": "Bitcoin rallies",
            "link": "https://www.coindesk.com/markets/2026/05/bitcoin",
            "published": "",
            "summary": "",
            "author": "",
            "tags": [],
        }
    ]


def test_html_fallback_handles_single_quotes_and_rejects_external_links() -> None:
    client = CoinDeskClient()

    articles = client._parse_json_or_html_articles(
        """
        <a href='https://www.coindesk.com/policy/2026/05/crypto-bill'>Crypto bill</a>
        <a href='https://evil.example/markets/2026/05/bitcoin'>Bad link</a>
        <a href='https://www.coindesk.com/about'>About</a>
        """
    )

    assert articles == [
        {
            "title": "Crypto bill",
            "link": "https://www.coindesk.com/policy/2026/05/crypto-bill",
            "published": "",
            "summary": "",
            "author": "",
            "tags": [],
        }
    ]
