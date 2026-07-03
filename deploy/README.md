# Deploy tooling (single-box OVH self-host)

Scripts for rebuilding/reloading the self-hosted Atrium + Centaur stack, and the
GitHub CD that drives it. Full setup: [`docs/self-host-ovh.md`](../docs/self-host-ovh.md).

## Files
- **`redeploy.sh [surface|centaur|all]`** — rebuild + reload on the box. Surgical
  (only changed images), `pg_dump`s first, **never `down -v`**, health-gates each
  side, and **auto-rolls-back** to the last-good version on failure. Surface rolls
  back by re-tagging the previous image; Centaur by re-deploying the last-good SHA.
- **`setup-registry.sh`** — one-time: a local `registry:2` on `localhost:5000` + a
  k3s HTTP mirror so Centaur deploys push SHA-tagged images. ⚠️ restarts k3s (a
  one-time all-pods bounce) — run in a quiet window.
- **`setup-k3s.sh`** — one-time (idempotent): tune kubelet image GC (start 70% /
  reclaim to 55%) via a `config.yaml.d` drop-in so the k3s image store self-bounds.
  ⚠️ restarts k3s only when the drop-in changes.

Image sprawl across three stores (docker build host, k3s containerd, local registry)
is the box's dominant disk consumer. `redeploy.sh` prunes the first two after each
deploy and `setup-k3s.sh` keeps the runtime store bounded; the registry is bounded by
a clean recreate (see `docs/self-host-ovh.md` — its `garbage-collect` is unsafe on this
`registry:2` version).
- **`values.box.yaml`** — the box's Centaur Helm overrides (per-user
  iron-proxy on, repo-cache on, NetworkPolicy off, node-sync capture on @ `cni0`,
  image repos at the registry), layered over `centaur/contrib/chart/values.dev.yaml`
  + `infra/values.local.yaml`.
- **`BOX_CONFIG.md`** — inventory of committed and box-local config sources, the
  expected live Centaur shape, and read-only drift audit commands.

## CD flow
`master` is the integration branch. **Promote to ship:** merge `master` → `deploy`.
A push to `deploy` triggers [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
on a **self-hosted runner on the box**, which syncs `~/atrium` to `origin/deploy`
and runs `redeploy.sh all`. Deploys are serial (one at a time) and never cancel a
running deploy. Status + logs live in the repo's **Actions** tab.

## Manual use (on the box)
```sh
~/atrium/deploy/redeploy.sh surface    # rebuild + reload just the surface server
~/atrium/deploy/redeploy.sh centaur    # rebuild changed Centaur images + roll api-rs
~/atrium/deploy/redeploy.sh all
```

## Notes
- Secrets stay box-local (`surface/deploy/.env`, the `centaur-infra-env` k8s secret,
  cloudflared config, compose overrides) — not in the repo; redeploy reuses them.
- An agent editing the platform runs in an isolated sandbox: its changes reach the
  CAS ledger, not `~/atrium`. To ship agent edits, open a PR → merge to `deploy`.
- Interactive hot-loop (Tilt / surface dev-mode) is **not** run on this box (it would
  clobber the live release); use a separate dev machine. See `docs/self-host-ovh.md`.
