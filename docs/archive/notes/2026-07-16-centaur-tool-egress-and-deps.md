# Why no Centaur tool can run in an Atrium sandbox

*2026-07-16. Written while wiring the `atrium-preview` tool (#547, #548) — the first
tool intended to actually execute in an Atrium sandbox, and therefore the first to hit
this.*

## The symptom

An agent asked to create a preview replied, honestly:

> I couldn't create the preview from this session. Blocked by environment/tool access.

The tool was installed and credentialed. Running it by hand in a live prod sandbox:

```
$ atrium-preview status prev-6426a5bda6f4-ac78
error: Request failed after 3 retries in 5.6s
  Caused by: Failed to fetch: `https://pypi.org/simple/typer/`
  Caused by: tunnel error: unsuccessful
```

This is not specific to `atrium-preview`. It is why `infra/values.local.yaml` carries
`TOOL_ALLOWLIST: "none"` with the comment "None of them work in Atrium sandboxes today."
**No tool can run.** The 78 upstream tools are hidden because they are dead, not because
they are unwanted.

## Why: two independent facts that collide

### 1. Tools resolve dependencies at run time, from PyPI

A tool shim execs `centaur-tools run <tool>`, which does
(`services/sandbox/install_tool_shims.py`, `run_tool`):

```python
subprocess.call(["uvx", "--from", str(project_dir), tool["name"], *args], env=tool_env())
```

`uvx --from` builds an **isolated venv** and resolves that tool's deps from an index at
first run. Three consequences, each verified in a live sandbox:

- The image's pre-baked libs do not help. The Dockerfile `pip3 install
  --break-system-packages`es `httpx` and `rich` (not `typer`) into *system* python;
  `uvx` ignores system site-packages entirely.
- **A zero-dependency tool does not help either.** I built a probe tool with
  `dependencies = []` and ran it in a prod sandbox. It still failed — on the *build
  backend*:

  ```
  ├─▶ Failed to fetch: `https://pypi.org/simple/hatchling/`
  ╰─▶ tunnel error: unsuccessful
  ```

  So "write tools without deps" is not a workaround. `uvx` needs an index no matter what.
- The uv cache is pointed at the node depcache (`entrypoint.sh:460`,
  `UV_CACHE_DIR="$DEP_CACHE_DIR/uv"`). On the box that directory is **252K and contains
  neither hatchling nor typer** — never warmed, because no tool has ever succeeded.
  Chicken-and-egg: the cache warms from a successful install; the first install needs the
  index.

### 2. Atrium runs iron-proxy in managed mode, where egress is deny-by-default

iron-proxy has two modes (`services/iron-proxy/entrypoint.sh`):

| | selector | config source | egress |
|---|---|---|---|
| **unmanaged** | `IRON_CONTROL_PLANE_URL` unset | baked `iron-proxy.yaml` | `domains: ["*"]` — **open** |
| **managed** | `IRON_CONTROL_PLANE_URL` set | iron-control `/api/v1/proxy/sync` | per-principal allowlist |

Upstream's default is `console.enabled: false` → unmanaged → open egress. **Upstream's
iron-proxy is a credential injector, not a firewall**, and `uvx` reaching PyPI is simply
assumed. There is no vendored index, no offline mode, no pre-baked-deps design upstream.

Atrium sets `console.enabled: true` (`deploy/values.box.yaml`) because we want per-user
BYO subscription credentials via per-principal grants. That flips the proxy to managed
mode — and silently converts egress from open to deny-by-default. PyPI was never
re-permitted, so every tool starves.

**This is the crux: we opted into the hardened mode for BYO credentials and inherited an
egress posture the tool mechanism was never designed for.** Nothing is broken; two
correct designs disagree.

## The allowlist semantics (the actual question)

Ground truth, read from the running console (`/rails/app/models/proxy.rb`, `merge_proxy_policy`):

```ruby
baseline = ProxyBaseline.effective_for(namespace)
allowlist_domains, other_baseline_transforms = split_allowlist_transforms(baseline["transforms"])
allowlist_domains += domains_from_rules(config)      # <-- hosts from GRANTED CREDENTIALS
allowlist = allowlist_domains.uniq.sort

transforms = []
transforms << { "name" => "allowlist", "config" => { "domains" => allowlist } } if allowlist.any?
```

The effective allowlist is:

> **union( baseline allowlist domains , hosts from granted credentials' `rules[].host` )**,
> deduped and sorted.

Four things follow, and they matter:

1. **It is additive (`+=`), not replacing.** Adding a domain to the baseline cannot remove
   `chatgpt.com`. My earlier worry — that declaring `["pypi.org"]` would deny
   `api.openai.com` and take down every agent turn — **is unfounded**. This was the
   specific thing worth verifying before touching prod.
2. **The allowlist is the egress gate**, not just credential scoping. The comment above it
   says iron-proxy's legacy top-level `secrets` field "rejects CONNECT tunnels before the
   synthesized allowlist can authorize them" — the allowlist is what *authorizes CONNECT*.
3. **A credential-less host can only come from the baseline.** `domains_from_rules` reads
   `rules[].host` off granted secrets, so hosts reachable via that path need a credential.
   PyPI has none.
4. **`if allowlist.any?`** — when the union is empty, **no allowlist transform is emitted
   at all**. Worth understanding before relying on it: a principal with no baseline and no
   grants may end up with no allowlist rather than an empty one. I did not verify how
   iron-proxy (closed-source image `ironsh/iron-proxy:0.46.0`) treats a missing allowlist.
   Today the baseline is always non-empty, so this is latent, not live.

### Where the baseline comes from

`registry.rs:164`, `proxy_baseline_input_from_fragment`:

> *"Pure translation: a fragment's non-secret transforms → baseline policy. Secret-bearing
> transforms are deliberately excluded here."*

and `is_secret_bearing_transform` is `"secrets" | "oauth_token" | "gcp_auth" |
"gcp_id_token" | "hmac_sign" | "aws_auth"`. **`allowlist` is not in that list**, so an
`allowlist` transform in a fragment flows through into the baseline. api-rs registers the
baseline for the infra role at startup (`args.rs`, `register_proxy_baseline_with_retry` /
`ProxyBaselineSpec::infra()`).

### There is already a precedent for exactly this

`centaur-iron-proxy/src/fragment.rs:210` — a pure allowlist fragment with **no secret at
all**:

```rust
// Per-user subscription: allowlist chatgpt.com (codex's normal egress
// restriction) but inject nothing — the per-principal iron-control grant carries
// the Bearer + chatgpt-account-id.
const CODEX_ACCESS_TOKEN_PER_USER_FRAGMENT: &str = r#"
transforms:
  - name: allowlist
    config:
      domains: ["chatgpt.com"]
"#;
```

Confirmed live on prod. The stored baseline:

```
namespace=default foreign_id=infra
transforms=[{"name" => "allowlist", "config" => {"domains" => ["chatgpt.com"]}}]
```

And the config a live sandbox actually receives from `/api/v1/proxy/sync`:

```json
{ "secrets": [],
  "transforms": [ { "name": "allowlist", "config": { "domains": ["chatgpt.com"] } } ] }
```

Note `secrets: []` — so `chatgpt.com` is reaching the sandbox **through the baseline**, not
through a credential rule. "Make a host reachable, inject nothing" is an established,
in-architecture pattern, already load-bearing for the only egress prod has.

**A prod sandbox's entire egress surface is `chatgpt.com`.**

## Options

### A. Add a PyPI allowlist fragment (the in-architecture fix)

Mirror `CODEX_ACCESS_TOKEN_PER_USER_FRAGMENT`: an `allowlist` transform carrying
`pypi.org` + `files.pythonhosted.org`, merged into the infra fragment so it lands in the
baseline and unions into every principal's allowlist.

- **Pro:** matches the mechanism's design and an existing precedent; union semantics make
  it non-destructive; unblocks the tool mechanism generally, not just this tool; the
  depcache warms after the first run.
- **Con:** sandboxes can reach PyPI. That is a real supply-chain surface — a compromised
  or typosquatted package executes in the sandbox. Note the sandbox already executes
  arbitrary model-authored code, so this widens an existing surface rather than opening a
  new class of one; worth deciding deliberately.
- **Fork cost:** `infra.yaml` / `fragment.rs` are vendored upstream files, so this edit
  re-conflicts on every `centaur-sync.sh` pull. Consider whether it belongs behind an
  Atrium values knob (e.g. an `extraAllowlistDomains` passthrough) instead of a baked
  constant — that would be new upstream-diverging code either way, but a values knob is a
  smaller, more stable diff than editing a baked fragment.
- **Unverified:** that adding it to the infra fragment produces the expected union in a
  real sandbox. The read is strong (source + live baseline + precedent) but it has not
  been executed. Test on the local stack (`just up`) before prod.

### B. Pre-warm the uv cache

Seed hatchling + each allowlisted tool's deps so `uvx` resolves offline.

- **Pro:** zero new egress — strictly the strongest posture.
- **Con:** `UV_CACHE_DIR` points at the **node depcache**, not the image, so an
  image-baked `/root/.cache/uv` is ignored at runtime. Would require seeding the node
  depcache, or not overriding `UV_CACHE_DIR`, or `uv tool install` at build (the image
  already does this for `manim`, `Dockerfile:212`) — which bypasses `centaur-tools run`'s
  `uvx` path and diverges further from upstream. Also needs `--offline`/`UV_OFFLINE` to
  stop uv from consulting the index for resolution, and every dep bump becomes an image
  rebuild.

### C. Do nothing

Tools stay dead; `TOOL_ALLOWLIST: "none"` stays honest. `atrium-preview` is merged,
deployed, and correct, and starts working the day this is fixed with no further changes.
The launcher API is reachable by any token holder regardless, so previews themselves are
unaffected.

## Recommendation

**A**, behind a values knob rather than a baked-constant edit if that proves workable,
after proving the union on the local stack. It is the only option that fixes the general
case, it matches upstream's design intent, and the semantics that made it scary
(replace-not-union) are now disproven.

But the real decision is a policy one, not a mechanism one: **should an Atrium sandbox be
able to reach PyPI at all?** If the answer is no, the honest conclusion is that the
uvx-based tool mechanism cannot work here and Atrium needs a different tool-execution
story (B, or dropping `uvx` isolation) — in which case `TOOL_ALLOWLIST: "none"` should
stay, and the 78 upstream tools stay dead by choice rather than by accident.

## Verified vs. assumed

**Verified** (source read + live prod):
- `run_tool` uses `uvx --from`; the zero-dep probe fails on `hatchling` in a real sandbox
- image pre-bakes `httpx`/`rich` into system python; `uvx` can't see them
- depcache uv tier is 252K, no hatchling/typer
- managed vs unmanaged mode selection in `entrypoint.sh`; upstream default is unmanaged
- allowlist = **union** of baseline + credential-rule hosts (`merge_proxy_policy`)
- `allowlist` survives baseline translation (not secret-bearing)
- prod baseline is `["chatgpt.com"]`; a live sandbox's whole egress surface is `chatgpt.com`
- `secrets: []` in the live sync payload → chatgpt.com arrives via the baseline

**Assumed / not verified:**
- that adding PyPI to the infra fragment yields the expected union end-to-end (not executed)
- how `ironsh/iron-proxy:0.46.0` behaves with **no** allowlist transform (closed source)
- whether a values-knob passthrough for baseline domains is cleanly expressible
- whether PyPI alone suffices, or uv also needs other hosts for resolution/downloads in
  practice

## Corrections to earlier claims

Three things asserted during this build that turned out to be **wrong**, recorded so they
don't get re-derived:

1. `deploy/preview/ovh/tool/iron-proxy.md` (now deleted) claimed top-level
   `[tool.centaur] hosts` "adds allowed upstream hosts" for a tool. **It does not.**
   `tools.rs:387` parses it as `default_hosts` — a fallback for *secrets* that don't
   declare their own hosts. `ToolManifest` has no hosts field. Adding `pypi.org` there
   would do nothing.
2. Same doc claimed the deployment's proxy "has a global `domains: ["*"]` allowlist, so no
   edit is necessary." That is true only of the **unmanaged** config, which prod never
   renders.
3. "Wire in `infra/llm-mock` so previews run agents" — the mock serves Anthropic
   `/v1/messages` while the harness is `codex`, and its `ANTHROPIC_BASE_URL` seam was
   deleted in the api-rs migration (`6e80fb85`). Previews have no model credentials; only
   the scripted first-run demo streams.
