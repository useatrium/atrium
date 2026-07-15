# Gallery Request Fanout Preview Deploy Notes

Date: 2026-07-15

## Deploy Under Test

- Branch: `fix/gallery-request-fanout`
- Commit: `9687777bfed3a51be217b4f9946bc0462167c08f`
- Preview id: `prev-9687777bfed3-5bd7`
- EC2 instance: `i-0c3d3f754985664cf`
- Initial EC2 URL: `http://ec2-54-89-244-184.compute-1.amazonaws.com`
- Expected sslip URL after ready: `https://54-89-244-184.sslip.io/`
- Launch created at: `2026-07-15T18:17:01.506430Z`
- Ready at: `2026-07-15T18:31:29Z`
- Total deploy time: about 14 minutes 28 seconds

## Speedup Attempted Before Launch

The branch diff against `origin/master` is Surface-only, but the branch differs from the currently cached Centaur image source commit in `runtime/node-sync`. To avoid reusing a stale Node Sync image:

- Reused ECR cache for:
  - `centaur-api-rs`
  - `centaur-iron-proxy`
  - `centaur-agent`
  - `centaur-console`
- Left `centaur-node-sync` uncached for this commit, so the deploy should build that service.
- Updated preview tooling to make cache decisions per Centaur service instead of falling back to a full rebuild when any single service image is missing.

## Observed Phase Times

- `packages`: `2026-07-15T18:18:03Z`
- `registry`: `2026-07-15T18:19:32Z`
- `surface-build`: `2026-07-15T18:19:57Z`
- `surface-initial`: `2026-07-15T18:21:35Z`
- `centaur-cache-hit-centaur-agent`: `2026-07-15T18:23:55Z`
- `centaur-cache-miss-centaur-node-sync`: `2026-07-15T18:26:40Z`
- `centaur-deploy`: `2026-07-15T18:29:28Z`
- `ready`: `2026-07-15T18:31:27Z`

## Observations So Far

- Fresh instance package installation is a meaningful fixed cost.
- k3s setup and local registry startup completed successfully.
- Surface build still downloads the full pnpm workspace on a fresh appliance. That is currently a major bottleneck before Centaur image caching can help.
- Surface server Docker build completed and the initial Surface stack reached `/healthz` successfully before Centaur image work began.
- ECR cache reuse is active for at least the first Centaur images pulled so far.
- The expected partial-cache path is working: `centaur-api-rs`, `centaur-iron-proxy`, and `centaur-agent` pulled from ECR; `centaur-node-sync` missed and began a Docker/Rust build.
- The `centaur-node-sync` miss pays the full Rust dependency download/compile cost on a fresh appliance.
- `centaur-console` also pulled from ECR after `centaur-node-sync` was built and pushed.
- Centaur rolled out successfully after image preparation.
- The Surface server was rewired after Centaur rollout and both final smoke checks returned `{"ok":true}`.
- The final ready metadata URL was `https://54-89-244-184.sslip.io`.
- Direct HTTPS checks succeeded:
  - `https://54-89-244-184.sslip.io/healthz` returned HTTP 200 with `{"ok":true}`.
  - `https://54-89-244-184.sslip.io/` returned HTTP 200 and served the Atrium index.

## Improvement Ideas

- Build a reusable preview appliance AMI with base packages, Docker, k3s, Helm, `just`, AWS CLI, and registry setup already installed.
- Cache or prebuild the Surface image by commit in ECR, not only Centaur images.
- Split Surface and Centaur image cache metadata by service and source hash, not only commit SHA, so unchanged services can be reused safely across branches.
- Add Rust build cache persistence for Centaur misses, likely via prebuilt service images, S3/EBS-backed BuildKit cache, or an AMI with warmed cargo registry/git cache.
- Push cache-hit images into the local registry with clearer log lines so deploy review does not require reading Docker pull output.
- Pre-pull common base images into the appliance AMI or a warm EBS snapshot.
- Add explicit phase duration logging in the launcher response instead of reconstructing timings from status files and bootstrap logs.
- Consider a warm stopped instance or ASG warm pool for interactive preview requests if startup latency matters more than idle cost.
- Make the launcher API return the final ready URL from `ready.json`; its status response still shows the initial EC2 HTTP hostname even after sslip HTTPS is ready.
- Keep the current fresh-instance path as the correctness baseline, because it proves previews are isolated and reproducible.

## Outcome

- Preview deployed successfully.
- Total time was about 14 minutes 28 seconds from launcher-created timestamp to ready timestamp.
- Only `centaur-node-sync` was rebuilt among the Centaur services for this branch deploy; the other Centaur service images were reused from ECR.
- Final URL: `https://54-89-244-184.sslip.io`
- Remaining functional verification: use the UI and ask an agent question from this preview.
