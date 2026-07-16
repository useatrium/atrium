#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import tarfile
import textwrap
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterator, Mapping

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_STATE_DIR = ROOT / "deploy" / "preview" / "ovh" / ".state"
STATE_DIR = Path(os.environ.get("ATRIUM_PREVIEW_STATE_DIR", DEFAULT_STATE_DIR))
REAL_FS_ROOT = Path(os.environ.get("ATRIUM_PREVIEW_REAL_FS_ROOT", "/var/lib/atrium-preview"))
CADDY_CONF_DIR = Path(os.environ.get("ATRIUM_PREVIEW_CADDY_CONF_DIR", "/etc/caddy/conf.d"))
REGISTRY_PUSH = os.environ.get("ATRIUM_PREVIEW_REGISTRY_PUSH", "localhost:5000")
REGISTRY_PULL = os.environ.get("ATRIUM_PREVIEW_REGISTRY_PULL", "registry:5000")
# The box registry container's real name (set by provision-box.sh) and the network
# alias the chart's image references resolve through.
REGISTRY_CONTAINER = os.environ.get("ATRIUM_PREVIEW_REGISTRY_CONTAINER", "atrium-preview-registry")
REGISTRY_ALIAS = REGISTRY_PULL.split(":")[0]
PREVIEW_DOMAIN = os.environ.get("ATRIUM_PREVIEW_DOMAIN", "preview.useatrium.com")
# Warm pnpm store from provision-box.sh, so the web build reuses downloads.
PNPM_STORE = Path(os.environ.get("ATRIUM_PREVIEW_PNPM_STORE", "/var/cache/atrium-preview/pnpm/store"))
WEB_BUILD_IMAGE = os.environ.get("ATRIUM_PREVIEW_WEB_BUILD_IMAGE", "node:24-alpine")
PORT_RANGE = range(21000, 29000)
NODE_PORT = 30080
CENTAUR_IMAGES = {
    "api-rs": "centaur-api-rs",
    "iron-proxy": "centaur-iron-proxy",
    "sandbox": "centaur-agent",
    "node-sync": "centaur-node-sync",
    "console": "centaur-console",
}
VALID_ID = re.compile(r"prev-[0-9a-f]{12}-[0-9a-f]{4}")


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def run(
    cmd: list[str],
    *,
    cwd: Path = ROOT,
    capture: bool = True,
    check: bool = True,
    timeout: int | None = None,
    env: Mapping[str, str] | None = None,
) -> str:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        timeout=timeout,
        env=merged_env,
    )
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(detail or f"command failed: {' '.join(cmd)}")
    return (proc.stdout or "").strip() if capture else ""


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "locks").mkdir(exist_ok=True)
    (STATE_DIR / "previews").mkdir(exist_ok=True)
    (STATE_DIR / "sources").mkdir(exist_ok=True)


def validate_preview_id(preview_id: str) -> None:
    if not VALID_ID.fullmatch(preview_id):
        raise ValueError("preview id must match prev-<12hex>-<4hex>")


def state_path(preview_id: str) -> Path:
    validate_preview_id(preview_id)
    return STATE_DIR / f"{preview_id}.json"


def runtime_dir(preview_id: str) -> Path:
    validate_preview_id(preview_id)
    return STATE_DIR / "previews" / preview_id


def status_path(preview_id: str) -> Path:
    return runtime_dir(preview_id) / "status.json"


def save_state(state: dict[str, Any]) -> None:
    ensure_state_dir()
    target = state_path(state["preview_id"])
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(target)
    target.chmod(0o600)


def load_state(preview_id: str) -> dict[str, Any] | None:
    path = state_path(preview_id)
    if not path.exists():
        return None
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"invalid preview state: {path}")
    return value


def write_phase(state: dict[str, Any], phase: str, **updates: Any) -> None:
    timestamp = now_utc().isoformat()
    state.update(updates)
    state["phase"] = phase
    state["phase_time"] = timestamp
    runtime_dir(state["preview_id"]).mkdir(parents=True, exist_ok=True)
    status = {
        "preview_id": state["preview_id"],
        "phase": phase,
        "time": timestamp,
        "status": state.get("status", "provisioning"),
    }
    status_path(state["preview_id"]).write_text(json.dumps(status, indent=2) + "\n")
    save_state(state)


def commit_for_ref(ref: str) -> str:
    commit_sha = run(["git", "rev-parse", f"{ref}^{{commit}}"])
    if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
        raise RuntimeError(f"git returned an invalid commit SHA: {commit_sha!r}")
    return commit_sha


def make_preview_id(commit_sha: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
        raise ValueError("commit_sha must be 40 lowercase hexadecimal characters")
    return f"prev-{commit_sha[:12]}-{secrets.token_hex(2)}"


@contextlib.contextmanager
def commit_build_lock(commit_sha: str) -> Iterator[None]:
    ensure_state_dir()
    path = STATE_DIR / "locks" / f"build-{commit_sha}.lock"
    with path.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def seed_git_repo(tree: Path, commit_sha: str) -> None:
    """Give an exported source tree a throwaway git history.

    `git archive` exports no .git, but centaur's Justfile evaluates
    `git rev-parse HEAD` at parse time, so every `just build-one` aborts with
    "not a git repository" without this. The AWS appliance bootstrap did the same
    thing.

    Note the OCI revision label on centaur images ends up as this synthetic SHA,
    not the real commit: centaur's `build-one` dispatches to a fresh `just`
    subprocess, which drops our `image_revision=<real sha>` override. That is
    cosmetic only — previewctl tags every image into the registry as
    <image>:<real commit sha>, and the chart pulls by that tag, so previews stay
    pinned to the right commit.
    """
    run(["git", "init", "-q"], cwd=tree)
    run(["git", "config", "user.email", "preview@atrium.local"], cwd=tree)
    run(["git", "config", "user.name", "Atrium Preview"], cwd=tree)
    run(["git", "add", "-A"], cwd=tree)
    run(["git", "commit", "-qm", f"preview source {commit_sha}"], cwd=tree)


def source_for_commit(commit_sha: str) -> Path:
    source = STATE_DIR / "sources" / commit_sha
    marker = source / ".atrium-preview-source"
    if marker.read_text().strip() == commit_sha if marker.exists() else False:
        return source
    temporary = source.with_name(f".{commit_sha}.tmp-{os.getpid()}")
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    archive = temporary.parent / f".{commit_sha}-{os.getpid()}.tar"
    try:
        run(["git", "archive", "--format=tar", f"--output={archive}", commit_sha])
        with tarfile.open(archive) as bundle:
            bundle.extractall(temporary, filter="data")
        # Write the marker before seeding so it lands inside the synthetic commit
        # and the tree is clean. centaur's Justfile appends "-dirty" to image
        # labels when `git status --porcelain` is non-empty.
        marker_in_temp = temporary / marker.name
        marker_in_temp.write_text(commit_sha + "\n")
        seed_git_repo(temporary, commit_sha)
        if source.exists():
            shutil.rmtree(temporary)
        else:
            temporary.replace(source)
    finally:
        archive.unlink(missing_ok=True)
        shutil.rmtree(temporary, ignore_errors=True)
    return source


def registry_has_image(image: str, tag: str) -> bool:
    request = urllib.request.Request(
        f"http://{REGISTRY_PUSH}/v2/library/{image}/manifests/{tag}", method="HEAD"
    )
    request.add_header(
        "Accept",
        "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, TimeoutError):
        return False


def build_and_push_images(source: Path, commit_sha: str) -> None:
    surface_image = "atrium-surface"
    if not registry_has_image(surface_image, commit_sha):
        target = f"{REGISTRY_PUSH}/library/{surface_image}:{commit_sha}"
        run(
            [
                "docker",
                "build",
                "--label",
                f"org.opencontainers.image.revision={commit_sha}",
                "-f",
                str(source / "surface" / "deploy" / "Dockerfile.server"),
                "-t",
                target,
                str(source),
            ],
            capture=False,
        )
        run(["docker", "push", target], capture=False)

    for service, image in CENTAUR_IMAGES.items():
        if registry_has_image(image, commit_sha):
            continue
        run(
            ["just", f"image_revision={commit_sha}", "build-one", service],
            cwd=source / "centaur",
            capture=False,
        )
        target = f"{REGISTRY_PUSH}/library/{image}:{commit_sha}"
        run(["docker", "tag", f"{image}:latest", target])
        run(["docker", "push", target], capture=False)


def build_web(source: Path) -> None:
    """Build the web SPA into surface/web/dist.

    The preview's caddy serves this as static files; without it the preview only
    answers API routes and every page load 404s. Mirrors the AWS appliance, and
    reuses the box's warm pnpm store so this is a cache hit after the first run.
    """
    PNPM_STORE.mkdir(parents=True, exist_ok=True)
    run(
        [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{source / 'surface'}:/app",
            "-v",
            f"{PNPM_STORE}:/pnpm-store",
            "-w",
            "/app",
            "-e",
            "CI=true",
            WEB_BUILD_IMAGE,
            "sh",
            "-c",
            "corepack enable && pnpm config set store-dir /pnpm-store --global "
            "&& pnpm install --frozen-lockfile && pnpm --filter @atrium/web build",
        ],
        capture=False,
    )


def appliance_values_yaml(commit_sha: str, surface_port: int) -> str:
    return textwrap.dedent(
        f"""\
        secretManager:
          backend: env
          existingSecretName: centaur-infra-env

        networkPolicy:
          enabled: false

        repoCache:
          enabled: false

        toolServer:
          enabled: false

        console:
          enabled: true
          image:
            repository: {REGISTRY_PULL}/library/centaur-console
            tag: {commit_sha}

        apiRs:
          sandboxWarmPoolSize: 0
          image:
            repository: {REGISTRY_PULL}/library/centaur-api-rs
            tag: {commit_sha}
          ironProxy:
            mode: enabled
            perUserSubscription: true

        ironProxy:
          image:
            repository: {REGISTRY_PULL}/library/centaur-iron-proxy
            tag: {commit_sha}

        sandbox:
          image:
            repository: {REGISTRY_PULL}/library/centaur-agent
            tag: {commit_sha}
          codexAuthMode: access_token
          claudeCodeAuthMode: access_token

        nodeSync:
          enabled: true
          overlayProvisioning:
            enabled: true
            flatHome: true
          atriumBaseUrl: "http://host.k3d.internal:{surface_port}"
          image:
            repository: {REGISTRY_PULL}/library/centaur-node-sync
            tag: {commit_sha}
          apiKeySecret:
            name: centaur-infra-env
            key: ARTIFACT_CAPTURE_API_KEY
        """
    )


def reserve_ports(count: int) -> list[int]:
    ensure_state_dir()
    used: set[int] = set()
    for path in STATE_DIR.glob("prev-*.json"):
        try:
            state = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if state.get("status") != "destroyed":
            used.update(int(port) for port in state.get("ports", {}).values())
    chosen: list[int] = []
    for port in PORT_RANGE:
        if port in used:
            continue
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        chosen.append(port)
        if len(chosen) == count:
            return chosen
    raise RuntimeError("no free preview ports are available")


@contextlib.contextmanager
def port_allocation_lock() -> Iterator[None]:
    ensure_state_dir()
    with (STATE_DIR / "locks" / "port-allocation.lock").open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def compose_command(state: dict[str, Any], *args: str) -> list[str]:
    source = Path(state["source_dir"])
    runtime = runtime_dir(state["preview_id"])
    return [
        "docker",
        "compose",
        # the prod compose gates its web-serving caddy behind this profile
        "--profile",
        "caddy",
        "-p",
        f"preview-{state['preview_id']}",
        "--env-file",
        str(runtime / ".env"),
        "-f",
        str(source / "surface" / "deploy" / "docker-compose.prod.yml"),
        "-f",
        str(runtime / "docker-compose.preview.yml"),
        *args,
    ]


def write_surface_files(state: dict[str, Any]) -> None:
    runtime = runtime_dir(state["preview_id"])
    runtime.mkdir(parents=True, exist_ok=True)
    ports = state["ports"]
    bucket = state["minio_bucket"]
    origin = state["url"]
    env_values = {
        "DB_PASSWORD": secrets.token_hex(24),
        "SESSION_SECRET": secrets.token_hex(32),
        "APP_SIGNING_SECRET": secrets.token_hex(32),
        "PROVIDER_CREDENTIAL_SECRET": secrets.token_hex(32),
        "MINIO_ACCESS_KEY": f"atrium-{state['preview_id']}",
        "MINIO_PASSWORD": secrets.token_hex(32),
        "S3_BUCKET": bucket,
        "S3_ENDPOINT": origin,
        "S3_INTERNAL_ENDPOINT": "http://minio:9000",
        "BIND_HOST": "127.0.0.1",
        "DB_BIND_HOST": "127.0.0.1",
        "SERVER_HOST_PORT": str(ports["surface"]),
        # The per-preview caddy serves the web SPA and proxies API paths to the
        # server. The box's shared caddy terminates TLS and proxies to this port.
        "CADDY_HOST_PORT": str(ports["caddy"]),
        "SITE_ADDRESS": ":80",
        "MINIO_HOST_PORT": str(ports["minio"]),
        "DB_HOST_PORT": str(ports["postgres"]),
        "AUTH_OPEN": "1",
        "AUTH_DEV_CODES": "1",
        "EMAIL_MODE": "log",
        "ARTIFACT_CAPTURE_API_KEY": state["artifact_capture_api_key"],
        "CENTAUR_BASE_URL": f"http://host.docker.internal:{ports['centaur']}",
        "CENTAUR_API_KEY": state["local_dev_api_key"],
    }
    (runtime / ".env").write_text("".join(f"{key}={value}\n" for key, value in env_values.items()))
    (runtime / ".env").chmod(0o600)
    (runtime / "docker-compose.preview.yml").write_text(
        textwrap.dedent(
            f"""\
            services:
              server:
                image: {REGISTRY_PUSH}/library/atrium-surface:{state['commit_sha']}
                build: !reset null
                extra_hosts:
                  - "host.docker.internal:host-gateway"
                environment:
                  APP_SIGNING_SECRET: ${{APP_SIGNING_SECRET}}
                  PROVIDER_CREDENTIAL_SECRET: ${{PROVIDER_CREDENTIAL_SECRET}}
              caddy:
                # !override, not a plain list: compose MERGES ports across files,
                # so without it we would also inherit the prod 80/443 bindings and
                # collide with the box's shared caddy and with other previews.
                ports: !override
                  - "127.0.0.1:${{CADDY_HOST_PORT}}:80"
            """
        )
    )


def create_k3d_cluster(state: dict[str, Any]) -> None:
    preview_id = state["preview_id"]
    cluster = f"preview-{preview_id}"
    real_fs = REAL_FS_ROOT / preview_id / "centaur"
    real_fs.mkdir(parents=True, exist_ok=True)
    filesystem = run(["findmnt", "-n", "-o", "FSTYPE", "--target", str(real_fs)])
    if filesystem != "ext4":
        raise RuntimeError(
            f"required Centaur bind mount is on {filesystem or 'an unknown filesystem'}, not ext4: {real_fs}"
        )
    # containerd defaults to HTTPS, but the box registry is plain HTTP on the
    # docker network. Without this every pod ends in ImagePullBackOff on
    #: Head "https://registry:5000/...".
    registries_yaml = runtime_dir(preview_id) / "registries.yaml"
    registries_yaml.write_text(
        textwrap.dedent(
            f"""\
            mirrors:
              "{REGISTRY_PULL}":
                endpoint:
                  - "http://{REGISTRY_PULL}"
            """
        )
    )
    run(
        [
            "k3d",
            "cluster",
            "create",
            cluster,
            "--no-lb",
            "--registry-config",
            str(registries_yaml),
            "--k3s-arg",
            "--disable=traefik@server:0",
            "--k3s-arg",
            "--disable=servicelb@server:0",
            "--volume",
            f"{real_fs}:/var/lib/centaur@server:0",
            # ":direct" binds the port straight to the server node. Without it k3d
            # creates a "proxy" mapping through the loadbalancer, which --no-lb
            # removed: "port-mapping of type 'proxy' specified, but loadbalancer
            # is disabled".
            "--port",
            f"127.0.0.1:{state['ports']['centaur']}:{NODE_PORT}@server:0:direct",
        ],
        capture=False,
    )
    # The shared registry is provisioned once by box setup under its own container
    # name; attach it to this cluster's network under the alias the chart pulls
    # from, so registry:5000 resolves inside the k3d node. Not check=False: a
    # silent failure here only resurfaces minutes later as ImagePullBackOff.
    try:
        run(
            [
                "docker",
                "network",
                "connect",
                "--alias",
                REGISTRY_ALIAS,
                f"k3d-{cluster}",
                REGISTRY_CONTAINER,
            ]
        )
    except RuntimeError as err:
        if "already exists" not in str(err):
            raise
    kubeconfig = run(["k3d", "kubeconfig", "get", cluster])
    path = runtime_dir(preview_id) / "kubeconfig.yaml"
    path.write_text(kubeconfig + "\n")
    path.chmod(0o600)
    state["kubeconfig"] = str(path)
    save_state(state)


def deploy_centaur(state: dict[str, Any]) -> None:
    source = Path(state["source_dir"])
    runtime = runtime_dir(state["preview_id"])
    values = runtime / "centaur-values.yaml"
    values.write_text(appliance_values_yaml(state["commit_sha"], state["ports"]["surface"]))
    kube_env = {
        "KUBECONFIG": state["kubeconfig"],
        "OP_SERVICE_ACCOUNT_TOKEN": "dummy",
        "OP_VAULT": "dummy",
        "SLACK_BOT_TOKEN": "dummy",
        "SLACK_SIGNING_SECRET": "dummy",
        "SLACKBOT_API_KEY": secrets.token_hex(32),
        "LOCAL_DEV_API_KEY": state["local_dev_api_key"],
    }
    run(["helm", "dependency", "update", "contrib/chart"], cwd=source / "centaur", env=kube_env)
    run(
        ["contrib/scripts/bootstrap-k8s-secrets.sh", "--namespace", "centaur"],
        cwd=source / "centaur",
        capture=False,
        env=kube_env,
    )
    patch = json.dumps(
        {"stringData": {"ARTIFACT_CAPTURE_API_KEY": state["artifact_capture_api_key"]}}
    )
    run(
        ["kubectl", "-n", "centaur", "patch", "secret", "centaur-infra-env", "--type", "merge", "-p", patch],
        env=kube_env,
    )
    run(
        [
            "helm",
            "upgrade",
            "--install",
            "centaur",
            "contrib/chart",
            "-n",
            "centaur",
            "--create-namespace",
            "-f",
            "contrib/chart/values.dev.yaml",
            "-f",
            str(source / "infra" / "values.local.yaml"),
            "-f",
            str(values),
        ],
        cwd=source / "centaur",
        capture=False,
        env=kube_env,
    )
    run(
        [
            "kubectl",
            "-n",
            "centaur",
            "patch",
            "svc",
            "centaur-centaur-api-rs",
            "--type",
            "merge",
            "-p",
            json.dumps({"spec": {"type": "NodePort", "ports": [{"port": 8080, "targetPort": 8080, "nodePort": NODE_PORT}]}}),
        ],
        env=kube_env,
    )
    for resource in (
        "deploy/centaur-centaur-api-rs",
        "deploy/centaur-centaur-console",
        "deploy/centaur-centaur-console-worker",
        "daemonset/centaur-centaur-node-sync",
    ):
        run(["kubectl", "-n", "centaur", "rollout", "status", resource, "--timeout=300s"], env=kube_env)


def wait_for_url(url: str, timeout: int = 400) -> None:
    deadline = time.monotonic() + timeout
    last_error = "not ready"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if 200 <= response.status < 300:
                    return
                last_error = f"HTTP {response.status}"
        except Exception as err:
            last_error = str(err)
        time.sleep(3)
    raise RuntimeError(f"health check timed out for {url}: {last_error}")


def write_caddy_fragment(state: dict[str, Any]) -> None:
    CADDY_CONF_DIR.mkdir(parents=True, exist_ok=True)
    target = CADDY_CONF_DIR / f"{state['preview_id']}.caddy"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(
        textwrap.dedent(
            f"""\
            {state['preview_id']}.{PREVIEW_DOMAIN} {{
                encode zstd gzip
                @minio path /{state['minio_bucket']}/*
                handle @minio {{
                    reverse_proxy 127.0.0.1:{state['ports']['minio']}
                }}
                handle {{
                    reverse_proxy 127.0.0.1:{state['ports']['caddy']}
                }}
            }}
            """
        )
    )
    temporary.replace(target)
    state["caddy_fragment"] = str(target)
    save_state(state)


def public_status(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": state["preview_id"],
        "repo": state.get("repo", "useatrium/atrium"),
        "ref": state.get("ref", state.get("commit_sha")),
        "commit_sha": state.get("commit_sha"),
        "status": state.get("status", "provisioning"),
        "url": state.get("url"),
        "initial_url": state.get("initial_url"),
        "expires_at": state.get("expires_at"),
        "phase": state.get("phase"),
        "phase_time": state.get("phase_time"),
        "ready_at": state.get("ready_at"),
        "failure_message": state.get("failure_message"),
    }


def cmd_create(args: argparse.Namespace) -> None:
    commit_sha = commit_for_ref(args.ref)
    preview_id = args.preview_id or make_preview_id(commit_sha)
    validate_preview_id(preview_id)
    if args.ttl_hours < 1 or args.ttl_hours > 72:
        raise ValueError("ttl_hours must be between 1 and 72")
    existing = load_state(preview_id)
    if existing and existing.get("status") != "destroyed":
        raise RuntimeError(f"preview already exists: {preview_id}")
    created_at = now_utc()
    url = f"https://{preview_id}.{PREVIEW_DOMAIN}"
    state: dict[str, Any] = {
        "preview_id": preview_id,
        "repo": "useatrium/atrium",
        "ref": args.ref,
        "commit_sha": commit_sha,
        "created_at": created_at.isoformat(),
        "expires_at": (created_at + dt.timedelta(hours=args.ttl_hours)).isoformat(),
        "status": "provisioning",
        "phase": "packages",
        "phase_time": created_at.isoformat(),
        "url": None,
        "initial_url": url,
        "ready_at": None,
        "failure_message": None,
        "minio_bucket": f"atrium-{preview_id}",
        "artifact_capture_api_key": secrets.token_hex(32),
        "local_dev_api_key": secrets.token_hex(32),
    }
    with port_allocation_lock():
        ports = reserve_ports(5)
        state["ports"] = dict(
            zip(("surface", "minio", "postgres", "centaur", "caddy"), ports, strict=True)
        )
        write_phase(state, "packages")
    try:
        write_phase(state, "source")
        source = source_for_commit(commit_sha)
        state["source_dir"] = str(source)
        save_state(state)

        write_phase(state, "build-lock")
        with commit_build_lock(commit_sha):
            write_phase(state, "surface-build")
            build_and_push_images(source, commit_sha)
            build_web(source)

        write_phase(state, "k3d-up")
        create_k3d_cluster(state)

        write_phase(state, "centaur-deploy")
        deploy_centaur(state)

        write_phase(state, "surface-up")
        write_surface_files(state)
        run(compose_command(state, "up", "-d", "--no-build"), capture=False)
        # No explicit bucket creation: the Surface server calls ensureBucket() on
        # boot (surface/server/src/s3.ts) and creates it with the credentials it
        # was configured with. The minio image's preconfigured "local" mc alias
        # carries default creds, so `mc mb` here just fails with Access Denied.

        write_phase(state, "migrate")
        # Surface applies migrations before it starts listening. The table check
        # makes this phase explicit without racing a second migration process.
        migration_check = compose_command(
            state,
            "exec",
            "-T",
            "db",
            "psql",
            "-U",
            "atrium",
            "-d",
            "atrium",
            "-c",
            "SELECT count(*) FROM schema_migrations",
        )
        migration_deadline = time.monotonic() + 400
        while True:
            try:
                run(migration_check, timeout=15)
                break
            except RuntimeError:
                if time.monotonic() >= migration_deadline:
                    raise RuntimeError("Surface migrations did not complete within 400 seconds") from None
                time.sleep(3)

        write_phase(state, "healthz")
        wait_for_url(f"http://127.0.0.1:{state['ports']['surface']}/healthz")

        write_phase(state, "route")
        write_caddy_fragment(state)

        ready_at = now_utc().isoformat()
        write_phase(
            state,
            "ready",
            status="ready",
            url=url,
            ready_at=ready_at,
            failure_message=None,
        )
    except Exception as err:
        write_phase(
            state,
            "failed",
            status="failed",
            failure_message=str(err),
        )
        raise
    print(json.dumps(public_status(state), indent=2))


def cmd_status(args: argparse.Namespace) -> None:
    state = load_state(args.preview_id)
    if state is None:
        raise SystemExit(f"unknown preview: {args.preview_id}")
    phase_file = status_path(args.preview_id)
    if phase_file.exists():
        phase = json.loads(phase_file.read_text())
        state["phase"] = phase.get("phase", state.get("phase"))
        state["phase_time"] = phase.get("time", state.get("phase_time"))
    print(json.dumps(public_status(state), indent=2))


def best_effort(cmd: list[str], **kwargs: Any) -> None:
    try:
        run(cmd, check=False, **kwargs)
    except (OSError, subprocess.SubprocessError):
        pass


def cmd_destroy(args: argparse.Namespace) -> None:
    validate_preview_id(args.preview_id)
    state = load_state(args.preview_id)
    cluster = f"preview-{args.preview_id}"

    # Cluster deletion is safe and idempotent even if the state file was lost.
    best_effort(["k3d", "cluster", "delete", cluster], capture=False)

    if state is not None and state.get("source_dir"):
        runtime = runtime_dir(args.preview_id)
        if (runtime / ".env").exists() and (runtime / "docker-compose.preview.yml").exists():
            # `down -v` removes this project's minio volume, taking the bucket
            # with it, so there is no separate bucket teardown to do.
            run(compose_command(state, "down", "-v", "--remove-orphans"), capture=False)

    fragment = (
        Path(state["caddy_fragment"])
        if state and state.get("caddy_fragment")
        else CADDY_CONF_DIR / f"{args.preview_id}.caddy"
    )
    fragment.unlink(missing_ok=True)
    shutil.rmtree(REAL_FS_ROOT / args.preview_id, ignore_errors=True)

    if state is not None:
        state.pop("artifact_capture_api_key", None)
        state.pop("local_dev_api_key", None)
        for sensitive_file in (".env", "kubeconfig.yaml", "centaur-values.yaml"):
            (runtime_dir(args.preview_id) / sensitive_file).unlink(missing_ok=True)
        write_phase(
            state,
            "destroyed",
            status="destroyed",
            destroyed_at=now_utc().isoformat(),
            url=None,
            failure_message=None,
        )
        out = public_status(state)
    else:
        out = {"id": args.preview_id, "status": "destroyed"}
    print(json.dumps(out, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Atrium OVH warm-box preview controller")
    # Retained as accepted no-ops so existing AWS launcher/tool invocations remain drop-in.
    parser.add_argument("--profile", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--region", default=None, help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="cmd", required=True)

    create = sub.add_parser("create")
    create.add_argument("ref", nargs="?", default="HEAD")
    create.add_argument("--preview-id")
    create.add_argument("--ttl-hours", type=int, default=24)
    create.set_defaults(func=cmd_create)

    status = sub.add_parser("status")
    status.add_argument("preview_id")
    status.set_defaults(func=cmd_status)

    destroy = sub.add_parser("destroy")
    destroy.add_argument("preview_id")
    destroy.add_argument("--wait", action="store_true", help=argparse.SUPPRESS)
    destroy.set_defaults(func=cmd_destroy)

    args = parser.parse_args()
    try:
        args.func(args)
    except (ValueError, RuntimeError) as err:
        print(json.dumps({"error": str(err)}))
        raise SystemExit(1) from err


if __name__ == "__main__":
    main()
