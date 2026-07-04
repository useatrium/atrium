# Single-Box Config Inventory

This is the source map for the Atrium + Centaur OVH box. It is meant to answer
"where does this setting come from?" before changing deploy behavior.

## Sources Of Truth

| Layer | Source | Lives in git? | Notes |
| --- | --- | --- | --- |
| Deploy orchestration | `deploy/redeploy.sh`, `.github/workflows/deploy.yml` | Yes | `deploy` branch pushes run on the self-hosted runner and call `redeploy.sh all`. |
| Surface services | `surface/deploy/docker-compose.prod.yml` plus box-local overrides | Partly | Runtime env is box-local in `~/atrium/surface/deploy/.env`. |
| Surface secrets | `~/atrium/surface/deploy/.env` | No | Do not commit values. Audit by key name only. |
| Surface deploy state | `${ATRIUM_DEPLOY_STATE_DIR:-<repo-parent>/atrium-deploy}` | No | Generated/runtime state for deploys. This is where host-local deploy artifacts belong, not under `~/atrium`; systemd units pin this path explicitly. |
| LiveKit TURN hostname | `LIVEKIT_TURN_DOMAIN` in `~/atrium/surface/deploy/.env` | No | Source of truth for the DNS-only TURN host, the certbot live directory, and the rendered runtime LiveKit config. |
| LiveKit runtime config | `${ATRIUM_DEPLOY_STATE_DIR}/surface` | No, generated | Deploy scripts materialize the host-local LiveKit config here from repo-managed inputs. Do not hand-edit `surface/deploy/livekit.yaml` on the box for production state. |
| TURN certificate renewal | `surface/deploy/renew-turn-cert.sh`, `surface/deploy/install-turn-renewal.sh` | Yes | Installer writes `/usr/local/sbin/atrium-renew-turn-cert` plus `atrium-renew-turn-cert.{service,timer}`. |
| Surface pnpm deploy store | Outside `~/atrium`, under host deploy state | No | `surface/.pnpm-store` should not exist in the checkout. |
| Centaur chart defaults | `centaur/contrib/chart/values.yaml` and `values.dev.yaml` | Yes | Upstream/fork defaults. Do not treat them as box-specific intent. |
| Atrium local Centaur overrides | `infra/values.local.yaml` | Yes | Shared simple/env-mode overrides. Some comments are local-dev oriented. |
| Box Centaur overrides | `deploy/values.box.yaml` | Yes | Primary committed source for the OVH box's Centaur shape. |
| Centaur secrets | Kubernetes secret `centaur-infra-env` in namespace `centaur` | No | Env-mode secret manager. Audit key names only. |
| Centaur image tags | Set by `deploy/redeploy.sh` during Helm upgrade | Yes, via script | Images are pushed to `localhost:5000/library/*:<sha>`, including console and console-worker. |
| Local registry | `deploy/setup-registry.sh` | Yes | One-time k3s registry mirror setup. |
| Tunnels/DNS | cloudflared/system config on the box | No | Keep operational notes in the runbook; do not commit credentials. |

## Centaur Values Layering

The box deploy layers values in this order:

```sh
helm upgrade --install centaur centaur/contrib/chart \
  -n centaur --create-namespace \
  -f centaur/contrib/chart/values.dev.yaml \
  -f infra/values.local.yaml \
  -f deploy/values.box.yaml \
  --set-string 'apiRs.image.tag=<sha>' \
  --set-string 'sandbox.image.tag=<sha>' \
  --set-string 'ironProxy.image.tag=<sha>' \
  --set-string 'nodeSync.image.tag=<sha>' \
  --set-string 'console.image.tag=<sha>'
```

Later layers win. `deploy/values.box.yaml` should explain every intentional
single-box override.

## Active Vs Stale Values

Most values listed below are active chart inputs. Two legacy values are still
present in local override files but should not be used for new configuration:

| Value | Status | Notes |
| --- | --- | --- |
| `api.enabled` | Legacy / inert | Kept `false` in `infra/values.local.yaml` as historical documentation. The current chart renders the Rust API from `apiRs.enabled`; no template reads `.Values.api.enabled`. |
| `tokenBroker.enabled` | Stale / ignored | Present only in `infra/values.local.yaml`. The current chart has no `tokenBroker` default/schema/template. Use `console.enabled`, `console.worker.enabled`, and iron-control `token_broker` secret sources for managed broker credentials. |

## Expected Box Shape

| Area | Expected value | Why |
| --- | --- | --- |
| `api.enabled` | `false` | Legacy/inert local override; the Rust `api-rs` service is controlled by `apiRs.enabled`. |
| `apiRs.enabled` | `true` | Surface talks to `api-rs`. |
| `console.enabled` | `true` | Iron-control stores per-principal grants and broker refresh state. |
| `apiRs.ironProxy.mode` | `enabled` | Sandboxes reach model providers through per-sandbox iron-proxy. |
| `apiRs.ironProxy.perUserSubscription` | `true` | ChatGPT/Claude subscription tokens are per user, not deployment-wide. |
| `sandbox.codexAuthMode` | `access_token` | Codex uses user subscription auth. |
| `sandbox.claudeCodeAuthMode` | `access_token` | Claude Code uses user subscription auth. |
| `tokenBroker.enabled` | `false` | Stale/ignored local override; broker credentials now live in console/iron-control, not a chart-level `tokenBroker` service. |
| `secretManager.backend` | `env` | Secrets come from `centaur-infra-env`. |
| `repoCache.enabled` | `true` | Tools, workflows, and skills use the node-local checkout under `/var/lib/centaur/repos`. |
| `networkPolicy.enabled` | `false` | Single-box bootstrap keeps sandbox egress open while policy is hardened separately. |
| `nodeSync.enabled` | `true` | Host-side capture and artifact hydration are enabled. |
| `nodeSync.atriumBaseUrl` | `http://10.42.0.1:3001` | k3s pods reach Surface through the host CNI address. |
| `toolServer.enabled` | `true` | Local sandbox topology mirrors the runtime's tool server path. |

## Repo Cache And Overlays

`repoCache` is storage and sync: a node-local mirror under
`/var/lib/centaur/repos`. The repo-cache DaemonSet periodically runs `git fetch`
for configured repositories and exposes those checkouts read-only to api-rs,
sandboxes, and node-sync.

`overlays.sources` is intent: the ordered list of repos whose `tools/`,
`workflows/`, `.agents/skills/`, personas, or prompt files should be available
to the runtime. The chart automatically adds `overlays.sources[*].repo` to the
repo-cache sync set when `repoCache.enabled=true`, and wires matching paths into
api-rs/sandbox env.

Use `repoCache.repositories` for a repo that should simply be mirrored on the
node, for example a cache seed or a repo consumed by a custom path. Use
`overlays.sources` when the repo is part of the runtime surface and should feed
tools, workflows, skills, personas, prompts, or default session repo overlays.
For private user repos, prefer the per-principal private repo path over a shared
`repoCache.githubToken`: the session marks the repo private, api-rs scopes it to
the user's iron-control principal, and a sandbox init clones/hydrates it through
that sandbox's iron-proxy into a principal-scoped cache.

## Read-Only Audit Commands

Run these from the box. They print config shape and secret key names, not secret
values.

```sh
helm get values -n centaur centaur --all
kubectl get pods,deploy,ds,svc -n centaur -o wide
kubectl get events -n centaur --sort-by=.lastTimestamp | tail -80
kubectl get secret -n centaur centaur-infra-env -o json | jq -r '.data | keys[]' | sort
kubectl get deploy -n centaur centaur-centaur-api-rs -o json \
  | jq -r '.spec.template.spec.containers[0].env[]?
    | [.name, (.value // ("secret:" + .valueFrom.secretKeyRef.name + "/" + .valueFrom.secretKeyRef.key))]
    | @tsv' \
  | sort
```

For Surface, inspect only keys:

```sh
cd ~/atrium/surface/deploy
sed -n 's/^\([^#=][^=]*\)=.*/\1=<redacted>/p' .env | sort
```

Surface deploy-state audit:

```sh
test ! -d ~/atrium/surface/.pnpm-store && echo 'OK: no repo-local pnpm store'
ls -la ~/atrium-deploy
ls -la ~/atrium-deploy/surface 2>/dev/null || echo 'no generated surface state yet'
systemctl list-timers --all '*turn*' '*cert*'
systemctl cat atrium-renew-turn-cert.service atrium-renew-turn-cert.timer
```

`LIVEKIT_TURN_DOMAIN` is not a secret, but keep it in `.env` with the other
surface runtime values so compose, certbot paths, and the generated LiveKit
runtime config agree. The committed compose already mounts
`/etc/letsencrypt/live/${LIVEKIT_TURN_DOMAIN}/fullchain.pem` and
`/etc/letsencrypt/live/${LIVEKIT_TURN_DOMAIN}/privkey.pem` into LiveKit; do not
add a cert-specific compose override for the normal OVH topology.

## Drift Rules

- If a live Helm value differs from this doc, either update the committed values
  or record why the live override is temporary.
- If a box-local secret key is required by a committed value, add the key name to
  the relevant runbook without committing its value.
- If `deploy/redeploy.sh` sets a value with `--set`, document it here because it
  will not appear in `deploy/values.box.yaml`.
- If LiveKit/TURN state differs from this doc, update `.env` or the deploy
  script path that generates `$HOME/atrium-deploy/surface`; do not fix it by
  hand-editing `surface/deploy/livekit.yaml` or creating a one-off compose cert
  override.
- Install or refresh the TURN cert renewal timer with
  `~/atrium/surface/deploy/install-turn-renewal.sh`; do not hand-maintain a
  second timer with an inline compose command.
- Do not fix production-only behavior by hand-editing live Kubernetes objects
  unless it is incident mitigation. Follow up with a committed values/script
  change.
