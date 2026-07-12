# syntax=docker/dockerfile:1.7
# centaur-node-sync image — the privileged per-node sync daemon (Track C4).
# Multi-stage: build the static-ish binary, ship a minimal privileged runtime.
# Built from the crate directory (its own cargo workspace):
#   docker build -t centaur-node-sync:latest runtime/node-sync
FROM rust:1-bookworm AS build
WORKDIR /work
COPY . .
ARG RUST_BUILD_PROFILE=release
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/work/target,sharing=locked \
    case "$RUST_BUILD_PROFILE" in \
      release) cargo build --release -p centaur-node-sync --bins; OUT=/work/target/release ;; \
      debug|dev) cargo build -p centaur-node-sync --bins; OUT=/work/target/debug ;; \
      *) echo "unsupported RUST_BUILD_PROFILE=$RUST_BUILD_PROFILE" >&2; exit 2 ;; \
    esac && mkdir -p /out && \
    cp "$OUT"/centaur-node-syncd "$OUT"/scan-demo "$OUT"/provision-overlay "$OUT"/warmcache-hydrate /out/

FROM debian:bookworm-slim
# The daemon needs coreutils + libc (dynamically linked), mount(8)/umount(8) for
# daemon-owned overlay lifecycle, git for repo lower clone/checkout fallback,
# and CA certs for egress TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git mount \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/centaur-node-syncd /usr/local/bin/centaur-node-syncd
COPY --from=build /out/scan-demo /usr/local/bin/scan-demo
COPY --from=build /out/provision-overlay /usr/local/bin/provision-overlay
COPY --from=build /out/warmcache-hydrate /usr/local/bin/warmcache-hydrate
# Runs privileged (overlay xattr reads + write-through-merged); the DaemonSet sets
# securityContext.privileged=true. No USER drop here — node-root is required.
ENTRYPOINT ["/usr/local/bin/centaur-node-syncd"]
