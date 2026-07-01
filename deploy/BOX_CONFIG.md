# Single-Box Config Inventory

This is the source map for the Atrium + Centaur OVH box. It is meant to answer
"where does this setting come from?" before changing deploy behavior.

## Sources Of Truth

| Layer | Source | Lives in git? | Notes |
| --- | --- | --- | --- |
| Deploy orchestration | `deploy/redeploy.sh`, `.github/workflows/deploy.yml` | Yes | `deploy` branch pushes run on the self-hosted runner and call `redeploy.sh all`. |
| Surface services | `surface/deploy/docker-compose.prod.yml` plus box-local overrides | Partly | Runtime env is box-local in `~/atrium/surface/deploy/.env`. |
| Surface secrets | `~/atrium/surface/deploy/.env` | No | Do not commit values. Audit by key name only. |
| Centaur chart defaults | `centaur/contrib/chart/values.yaml` and `values.dev.yaml` | Yes | Upstream/fork defaults. Do not treat them as box-specific intent. |
| Atrium local Centaur overrides | `infra/values.local.yaml` | Yes | Shared simple/env-mode overrides. Some comments are local-dev oriented. |
| Box Centaur overrides | `deploy/values.box.yaml` | Yes | Primary committed source for the OVH box's Centaur shape. |
| Centaur secrets | Kubernetes secret `centaur-infra-env` in namespace `centaur` | No | Env-mode secret manager. Audit key names only. |
| Centaur image tags | Set by `deploy/redeploy.sh` during Helm upgrade | Yes, via script | Images are pushed to `localhost:5000/library/*:<sha>`. Console uses `latest`. |
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
  --set 'apiRs.image.tag=<sha>' \
  --set 'sandbox.image.tag=<sha>' \
  --set 'ironProxy.image.tag=<sha>' \
  --set 'nodeSync.image.tag=<sha>'
```

Later layers win. `deploy/values.box.yaml` should explain every intentional
single-box override.

## Expected Box Shape

| Area | Expected value | Why |
| --- | --- | --- |
| `api.enabled` | `false` | The Rust `api-rs` service is the active Centaur API. |
| `apiRs.enabled` | `true` | Surface talks to `api-rs`. |
| `console.enabled` | `true` | Iron-control stores per-principal grants and broker refresh state. |
| `apiRs.ironProxy.mode` | `enabled` | Sandboxes reach model providers through per-sandbox iron-proxy. |
| `apiRs.ironProxy.perUserSubscription` | `true` | ChatGPT/Claude subscription tokens are per user, not deployment-wide. |
| `sandbox.codexAuthMode` | `access_token` | Codex uses user subscription auth. |
| `sandbox.claudeCodeAuthMode` | `access_token` | Claude Code uses user subscription auth. |
| `tokenBroker.enabled` | `false` | The box is not using deployment-wide broker credentials. |
| `secretManager.backend` | `env` | Secrets come from `centaur-infra-env`. |
| `repoCache.enabled` | `true` | Tools, workflows, and skills use the node-local checkout under `/var/lib/centaur/repos`. |
| `networkPolicy.enabled` | `false` | Single-box bootstrap keeps sandbox egress open while policy is hardened separately. |
| `nodeSync.enabled` | `true` | Host-side capture and artifact hydration are enabled. |
| `nodeSync.atriumBaseUrl` | `http://10.42.0.1:3001` | k3s pods reach Surface through the host CNI address. |
| `toolServer.enabled` | `true` | Local sandbox topology mirrors the runtime's tool server path. |

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

## Drift Rules

- If a live Helm value differs from this doc, either update the committed values
  or record why the live override is temporary.
- If a box-local secret key is required by a committed value, add the key name to
  the relevant runbook without committing its value.
- If `deploy/redeploy.sh` sets a value with `--set`, document it here because it
  will not appear in `deploy/values.box.yaml`.
- Do not fix production-only behavior by hand-editing live Kubernetes objects
  unless it is incident mitigation. Follow up with a committed values/script
  change.
