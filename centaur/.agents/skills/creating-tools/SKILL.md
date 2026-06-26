---
name: creating-tools
description: "Scaffold and build new tool integrations in tools/. Use when asked to create a new tool, add an API integration, or build a new client for an external service."
---

# Creating Tools

Scaffold and implement new tool integrations following the established conventions.

## File Structure

Every tool lives at `tools/<name>/` with exactly these files:

```
tools/<name>/
├── __init__.py        # Empty file
├── .env.example       # Document required secrets (one per line: KEY=description)
├── client.py          # API client class + _client() factory function
├── cli.py             # Typer CLI for standalone use
└── pyproject.toml     # Package metadata + [tool.ai-v2] section
```

## Step-by-Step

### 1. Create `pyproject.toml`

```toml
[project]
name = "<name>"
description = "<One-line description of what the tool does>"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "httpx>=0.27.0",
    "typer>=0.12.0",
    "rich>=13.0.0",
    "python-dotenv>=1.0.0",
]

[project.scripts]
<name> = "<name>.cli:app"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ai-v2]
module = "client.py"
```

The `[tool.ai-v2] module = "client.py"` line is **required** — the tool manager uses it to discover and register the tool.

Add extra dependencies only if needed (e.g., `websockets`, `pydantic`). The base set (`httpx`, `typer`, `rich`, `python-dotenv`) covers most tools.

### 2. Create `client.py`

Rules:
- **NO `load_dotenv()`** — secrets come from `secret()` helper or env vars at runtime
- **Import `secret` from `shared.tool_sdk`** — never use `os.getenv()` for API keys
- **Class-based** — one main client class with public methods
- **`_client()` factory function** at module bottom — this is how the tool manager instantiates the client
- **Methods starting with `_` are excluded** from tool registration (use for internal helpers)
- **Lifecycle methods** (`close`, `__enter__`, `__exit__`) are also excluded
- **All imports at file top** — never inside functions
- **Type hints on all public methods** — the tool manager uses them to generate schemas

```python
"""<Name> API client."""

import httpx
from shared.tool_sdk import secret


class <Name>Client:
    """Client for <Name> API."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.base_url = "https://api.example.com"
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _get_api_key(self) -> str | None:
        if self._api_key:
            return self._api_key
        return secret("<NAME>_API_KEY", "")

    def _request(self, endpoint: str, params: dict | None = None) -> dict | list:
        api_key = self._get_api_key()
        if not api_key:
            raise RuntimeError("<NAME>_API_KEY not set.")
        url = f"{self.base_url}{endpoint}"
        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            response = self.client.get(url, params=params, headers=headers)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def search(self, query: str, limit: int = 10) -> dict:
        """Search for items."""
        return self._request("/search", params={"q": query, "limit": limit})

    def close(self):
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> <Name>Client:
    api_key = secret("<NAME>_API_KEY", "")
    if not api_key:
        raise RuntimeError("<NAME>_API_KEY not set.")
    return <Name>Client(api_key=api_key)
```

### 3. Create `cli.py`

Rules:
- **YES `load_dotenv()` at the very top** — CLIs run standalone and need to load `.env`
- Thin wrapper around the client — each CLI command calls one client method
- Use `typer` for the CLI framework
- Use `rich` or `shared.cli_tables` for formatted output
- Support `--json` and `--markdown` output flags on every command

```python
"""CLI for <Name> API."""

from dotenv import load_dotenv

load_dotenv()

import json

import typer
from rich.console import Console
from shared.cli_tables import Table

app = typer.Typer(name="<name>", help="<Description>")
console = Console()


def get_client():
    from .client import <Name>Client
    return <Name>Client()


@app.command()
def search(
    query: str = typer.Argument(..., help="Search query"),
    limit: int = typer.Option(10, "--limit", "-n", help="Max results"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Search for items."""
    client = get_client()
    data = client.search(query, limit=limit)
    if json_output:
        print(json.dumps(data, indent=2))
        return
    # ... rich table output ...


if __name__ == "__main__":
    app()
```

### 4. Create `__init__.py`

Empty file:
```python
```

### 5. Create `.env.example`

```
NAME_API_KEY=your-api-key-here
```

### 6. Add to 1Password (if needed)

If this is a credentialed tool, add the secret to 1Password:
- Vault: use the vault configured for your deployment
- Account: use the 1Password account configured for your deployment
- Item title: use the exact `ENV_VAR` name (e.g., `COINGECKO_API_KEY`)

### 7. Update `tools/README.md`

Add a row to the "Available Plugins" table with the tool name, description, and required secrets.

## Secrets Resolution Order

1. Tool `.env` file (`tools/<name>/.env`) — per-tool overrides for local dev
2. Root `.env` file (repo root) — central file for all secrets
3. Environment variables — Docker, CI, 1Password secret manager
4. Secret manager sidecar (`http://secrets:8100`) — production (accessed via `secret()`)

**Always use `secret("KEY")` in client.py** — it handles all resolution layers. Never use `os.getenv()` or `os.environ` for API keys.

## Common Patterns

### No-auth tools (public APIs)
Skip `_get_api_key()` and auth headers. The `_client()` factory can be simpler:
```python
def _client() -> DefillLlamaClient:
    return DefiLlamaClient()
```

### Multi-secret tools
Some tools need multiple credentials:
```python
def _client() -> CoinbaseClient:
    return CoinbaseClient(
        api_key=secret("COINBASE_API_KEY"),
        api_secret=secret("COINBASE_API_SECRET"),
        passphrase=secret("COINBASE_API_PASSPHRASE"),
    )
```

### Secret cleaning
1Password sometimes returns multi-line blobs. If your API is sensitive to whitespace:
```python
def _clean_secret(value: str) -> str:
    return value.strip().split("\n")[0].strip()
```

### POST/mutation methods
Name methods clearly (`create_`, `delete_`, `update_`). The tool-qa skill skips these during automated testing, but they're still registered for agent use.

## Testing

After creating the tool:

1. **Verify registration**: restart the API (or hit `POST /admin/reload-tools`) and check `GET /tools` includes your tool
2. **Run tool-qa**: use the `tool-qa` skill to systematically test all methods
3. **Test via curl**:
```bash
source .env
curl -s "http://localhost:8000/tools/<name>" \
  -H "Authorization: Bearer $API_SECRET_KEY" | jq

curl -s -X POST "http://localhost:8000/tools/<name>/search" \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "test", "limit": 3}' | jq
```

## Deployment

Tools are **hot-reloaded** — no container restart needed. On merge to `main`:
1. CI runs `git pull` on the server
2. The API's file watcher detects changes in `tools/`
3. Tool is auto-reloaded within seconds
4. Fallback: `POST /admin/reload-tools`
