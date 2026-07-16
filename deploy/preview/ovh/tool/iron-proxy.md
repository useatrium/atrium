# `atrium-preview` iron-proxy wiring

The production tool manifest must use Centaur's inject-mode HTTP secret. Add this
exact `[tool.centaur]` configuration to the manifest that packages
`atrium-preview` into the production tool overlay:

```toml
[tool.centaur]
hosts = ["preview-launcher.useatrium.com"]
secrets = [
    {type = "http", name = "ATRIUM_PREVIEW_LAUNCHER_TOKEN", mode = "inject", inject_header = "Authorization", inject_formatter = "Bearer {{ .Value }}", hosts = ["preview-launcher.useatrium.com"]},
]
```

Store the token in the production secret backend under the exact name
`ATRIUM_PREVIEW_LAUNCHER_TOKEN`. For the production 1Password source used by
this fork, that means an item named `ATRIUM_PREVIEW_LAUNCHER_TOKEN` in the
configured `OP_VAULT`; register/grant the tool with the production
`onepassword` or `onepassword-connect` source policy as appropriate. Do not put
the value in the manifest or any sandbox environment variable.

This configuration has two separate, host-scoped controls:

- top-level `hosts` adds only `preview-launcher.useatrium.com` to the tool's
  allowed upstream hosts;
- the secret's `hosts` limits bearer injection to that same hostname.

The CLI deliberately sends no `Authorization` header and no token placeholder.
Inject mode creates the header at the proxy boundary. The real token must never
reach the sandbox, transcript, logs, prompt, CLI output, or launcher error
reporting. Proxy request logging must redact injected header values.

The deployment's baked unmanaged proxy currently has a global `domains: ["*"]`
allowlist, so no edit to that YAML is necessary for the hostname to work. If
production overrides the global proxy allowlist, add
`preview-launcher.useatrium.com` to its explicit `transforms` → `allowlist` →
`config.domains` list as well.

## Repository evidence

- `centaur/tools/business/pylon/pyproject.toml` is a concrete bearer-injection
  example using `mode = "inject"`, `inject_header = "Authorization"`,
  `inject_formatter = "Bearer {{ .Value }}"`, and host-scoped `hosts`.
- `centaur/tools/infra/posthog/pyproject.toml` shows the same bearer-injection
  shape together with a top-level tool `hosts` allowlist.
- `centaur/services/iron-proxy/iron-proxy.yaml` is the active unmanaged proxy
  configuration. It defines the global domain allowlist and permits the
  `authorization` header through `header_allowlist`.
- `centaur/AGENTS.md` (Credential Injection and Secrets sections) documents
  per-sandbox in-flight replacement and the configured secret source.
- `centaur/docs/public/md/extend/tools.md` documents `hosts` as the upstream
  allowlist and inject-mode metadata as the tool manifest contract.

There is no config-format uncertainty: these fields and this TOML shape are in
active tool manifests in this fork. The integration owner still needs to place
the block in the eventual packaged tool manifest because this lane is scoped to
the three files in `deploy/preview/ovh/tool/`.
