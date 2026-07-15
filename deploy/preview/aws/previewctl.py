#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import io
import json
import os
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
import urllib.request
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[3]
STATE_DIR = ROOT / "deploy" / "preview" / "aws" / ".state"
DEFAULT_REGION = "us-east-1"
DEFAULT_INSTANCE_TYPE = "t3a.xlarge"
DEFAULT_VOLUME_GB = 160
ROLE_NAME = "atrium-preview-appliance-role"
PROFILE_NAME = "atrium-preview-appliance-profile"
SG_NAME = "atrium-preview-appliance"
KEY_NAME = "atrium-preview-appliance"


def run(cmd: list[str], *, cwd: Path = ROOT, capture: bool = True) -> str:
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return proc.stdout.strip() if capture else ""


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def json_default(value: Any) -> str:
    if isinstance(value, dt.datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def state_path(preview_id: str) -> Path:
    return STATE_DIR / f"{preview_id}.json"


def save_state(state: dict[str, Any]) -> None:
    ensure_state_dir()
    state_path(state["preview_id"]).write_text(json.dumps(state, indent=2, default=json_default) + "\n")


def load_state(preview_id: str) -> dict[str, Any]:
    return json.loads(state_path(preview_id).read_text())


def get_control_json(s3, state: dict[str, Any], name: str) -> dict[str, Any] | None:
    try:
        res = s3.get_object(
            Bucket=state["control_bucket"],
            Key=f"{state['control_prefix']}/{name}",
        )
    except ClientError as err:
        if err.response["Error"]["Code"] in {"NoSuchKey", "NoSuchBucket", "404"}:
            return None
        raise
    return json.loads(res["Body"].read().decode())


def account_id(session: boto3.Session) -> str:
    return session.client("sts").get_caller_identity()["Account"]


def current_ip() -> str | None:
    try:
        with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=5) as res:
            value = res.read().decode().strip()
            return value or None
    except Exception:
        return None


def slug(value: str, limit: int = 12) -> str:
    safe = "".join(ch.lower() if ch.isalnum() else "-" for ch in value)
    safe = "-".join(part for part in safe.split("-") if part)
    return safe[:limit] or "preview"


def commit_for_ref(ref: str) -> str:
    return run(["git", "rev-parse", f"{ref}^{{commit}}"])


def make_preview_id(commit_sha: str) -> str:
    return f"prev-{commit_sha[:12]}-{secrets.token_hex(2)}"


def make_tags(preview_id: str, commit_sha: str) -> list[dict[str, str]]:
    return [
        {"Key": "Project", "Value": "atrium"},
        {"Key": "Component", "Value": "preview"},
        {"Key": "PreviewId", "Value": preview_id},
        {"Key": "CommitSha", "Value": commit_sha},
    ]


def create_bucket(s3, bucket: str, region: str) -> None:
    try:
        s3.head_bucket(Bucket=bucket)
        return
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code")
        if code not in {"404", "NoSuchBucket", "NotFound"}:
            raise
    kwargs: dict[str, Any] = {"Bucket": bucket}
    if region != "us-east-1":
        kwargs["CreateBucketConfiguration"] = {"LocationConstraint": region}
    s3.create_bucket(**kwargs)
    waiter = s3.get_waiter("bucket_exists")
    waiter.wait(Bucket=bucket)


def empty_bucket(s3, bucket: str) -> None:
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        objects = [{"Key": item["Key"]} for item in page.get("Contents", [])]
        if objects:
            s3.delete_objects(Bucket=bucket, Delete={"Objects": objects})


def ensure_instance_role(session: boto3.Session, control_bucket: str) -> str:
    iam = session.client("iam")
    trust = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": "ec2.amazonaws.com"},
                "Action": "sts:AssumeRole",
            }
        ],
    }
    try:
        iam.get_role(RoleName=ROLE_NAME)
    except ClientError as err:
        if err.response["Error"]["Code"] != "NoSuchEntity":
            raise
        iam.create_role(RoleName=ROLE_NAME, AssumeRolePolicyDocument=json.dumps(trust))
    iam.attach_role_policy(
        RoleName=ROLE_NAME,
        PolicyArn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    )
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["s3:GetObject", "s3:ListBucket", "s3:PutObject"],
                "Resource": [
                    f"arn:aws:s3:::{control_bucket}",
                    f"arn:aws:s3:::{control_bucket}/previews/*",
                ],
            }
        ],
    }
    iam.put_role_policy(RoleName=ROLE_NAME, PolicyName="atrium-preview-control-s3", PolicyDocument=json.dumps(policy))
    try:
        iam.get_instance_profile(InstanceProfileName=PROFILE_NAME)
    except ClientError as err:
        if err.response["Error"]["Code"] != "NoSuchEntity":
            raise
        iam.create_instance_profile(InstanceProfileName=PROFILE_NAME)
    profile = iam.get_instance_profile(InstanceProfileName=PROFILE_NAME)["InstanceProfile"]
    if not any(role["RoleName"] == ROLE_NAME for role in profile.get("Roles", [])):
        try:
            iam.add_role_to_instance_profile(InstanceProfileName=PROFILE_NAME, RoleName=ROLE_NAME)
        except ClientError as err:
            if err.response["Error"]["Code"] != "LimitExceeded":
                raise
        time.sleep(10)
    return PROFILE_NAME


def ensure_security_group(session: boto3.Session, region: str) -> str:
    ec2 = session.client("ec2", region_name=region)
    vpcs = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"]
    if not vpcs:
        raise SystemExit("No default VPC found; create one or extend previewctl to accept a VPC id.")
    vpc_id = vpcs[0]["VpcId"]
    groups = ec2.describe_security_groups(
        Filters=[{"Name": "group-name", "Values": [SG_NAME]}, {"Name": "vpc-id", "Values": [vpc_id]}]
    )["SecurityGroups"]
    if groups:
        sg_id = groups[0]["GroupId"]
    else:
        sg_id = ec2.create_security_group(
            GroupName=SG_NAME,
            Description="Atrium disposable preview appliance",
            VpcId=vpc_id,
        )["GroupId"]
    rules = [
        {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "HTTP preview"}]},
        {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "HTTPS future"}]},
    ]
    ip = current_ip()
    if ip:
        rules.append(
            {
                "IpProtocol": "tcp",
                "FromPort": 22,
                "ToPort": 22,
                "IpRanges": [{"CidrIp": f"{ip}/32", "Description": "operator SSH"}],
            }
        )
    for rule in rules:
        try:
            ec2.authorize_security_group_ingress(GroupId=sg_id, IpPermissions=[rule])
        except ClientError as err:
            if err.response["Error"]["Code"] != "InvalidPermission.Duplicate":
                raise
    return sg_id


def ensure_key_pair(session: boto3.Session, region: str) -> str:
    ec2 = session.client("ec2", region_name=region)
    ensure_state_dir()
    key_path = STATE_DIR / f"{KEY_NAME}.pem"
    try:
        ec2.describe_key_pairs(KeyNames=[KEY_NAME])
        if not key_path.exists():
            print(f"warning: EC2 key pair {KEY_NAME} exists but {key_path} is missing; SSH may require SSM", file=sys.stderr)
        return KEY_NAME
    except ClientError as err:
        if err.response["Error"]["Code"] != "InvalidKeyPair.NotFound":
            raise
    material = ec2.create_key_pair(KeyName=KEY_NAME, KeyType="ed25519")["KeyMaterial"]
    key_path.write_text(material)
    key_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return KEY_NAME


def create_s3_user(session: boto3.Session, preview_id: str, bucket: str) -> dict[str, str]:
    iam = session.client("iam")
    user = f"atrium-preview-s3-{preview_id.removeprefix('prev-')}"
    user = user[:64]
    iam.create_user(UserName=user, Tags=[{"Key": "PreviewId", "Value": preview_id}, {"Key": "Project", "Value": "atrium"}])
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["s3:ListBucket"],
                "Resource": f"arn:aws:s3:::{bucket}",
            },
            {
                "Effect": "Allow",
                "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
                "Resource": f"arn:aws:s3:::{bucket}/*",
            },
        ],
    }
    iam.put_user_policy(UserName=user, PolicyName="atrium-preview-storage", PolicyDocument=json.dumps(policy))
    key = iam.create_access_key(UserName=user)["AccessKey"]
    return {"user": user, "access_key_id": key["AccessKeyId"], "secret_access_key": key["SecretAccessKey"]}


def delete_s3_user(session: boto3.Session, user: str | None) -> None:
    if not user:
        return
    iam = session.client("iam")
    try:
        for key in iam.list_access_keys(UserName=user).get("AccessKeyMetadata", []):
            iam.delete_access_key(UserName=user, AccessKeyId=key["AccessKeyId"])
        for policy in iam.list_user_policies(UserName=user).get("PolicyNames", []):
            iam.delete_user_policy(UserName=user, PolicyName=policy)
        iam.delete_user(UserName=user)
    except ClientError as err:
        if err.response["Error"]["Code"] != "NoSuchEntity":
            raise


def package_source(commit_sha: str) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".tar.gz") as tmp:
        run(["git", "archive", "--format=tar.gz", "-o", tmp.name, commit_sha])
        return Path(tmp.name).read_bytes()


def appliance_values_yaml(commit_sha: str) -> str:
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
            repository: localhost:5000/library/centaur-console

        apiRs:
          sandboxWarmPoolSize: 0
          image:
            repository: localhost:5000/library/centaur-api-rs
          ironProxy:
            mode: enabled
            perUserSubscription: true

        ironProxy:
          image:
            repository: localhost:5000/library/centaur-iron-proxy

        sandbox:
          image:
            repository: localhost:5000/library/centaur-agent
          codexAuthMode: access_token
          claudeCodeAuthMode: access_token

        nodeSync:
          enabled: true
          overlayProvisioning:
            enabled: true
            flatHome: true
          atriumBaseUrl: "http://10.42.0.1:3001"
          image:
            repository: localhost:5000/library/centaur-node-sync
          apiKeySecret:
            name: centaur-infra-env
            key: ARTIFACT_CAPTURE_API_KEY
        """
    )


def bootstrap_script(params: dict[str, str]) -> str:
    values_b64 = base64.b64encode(appliance_values_yaml(params["commit_sha"]).encode()).decode()
    return textwrap.dedent(
        f"""\
        #!/usr/bin/env bash
        set -euo pipefail
        exec > >(tee -a /var/log/atrium-preview-bootstrap.log) 2>&1

        PREVIEW_ID={params["preview_id"]!r}
        COMMIT_SHA={params["commit_sha"]!r}
        REGION={params["region"]!r}
        CONTROL_BUCKET={params["control_bucket"]!r}
        CONTROL_PREFIX={params["control_prefix"]!r}
        STORAGE_BUCKET={params["storage_bucket"]!r}
        S3_ACCESS_KEY={params["s3_access_key"]!r}
        S3_SECRET_KEY={params["s3_secret_key"]!r}
        ARTIFACT_CAPTURE_API_KEY={params["artifact_capture_api_key"]!r}
        LOCAL_DEV_API_KEY={params["local_dev_api_key"]!r}

        status() {{
          mkdir -p /var/lib/atrium-preview
          printf '{{"preview_id":"%s","phase":"%s","time":"%s"}}\\n' "$PREVIEW_ID" "$1" "$(date -Is)" > /var/lib/atrium-preview/status.json
          if command -v aws >/dev/null 2>&1; then
            aws s3 cp /var/lib/atrium-preview/status.json "s3://$CONTROL_BUCKET/$CONTROL_PREFIX/status.json" >/dev/null 2>&1 || true
          fi
        }}

        status packages
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y ca-certificates curl unzip git jq openssl docker.io docker-buildx docker-compose-v2 build-essential pkg-config libssl-dev clang protobuf-compiler
        systemctl enable --now docker

        if ! command -v aws >/dev/null 2>&1; then
          aws_arch="$(uname -m)"
          case "$aws_arch" in
            aarch64|arm64) aws_pkg=aarch64 ;;
            x86_64|amd64) aws_pkg=x86_64 ;;
            *) echo "unsupported arch for awscli: $aws_arch" >&2; exit 1 ;;
          esac
          curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${{aws_pkg}}.zip" -o /tmp/awscliv2.zip
          rm -rf /tmp/aws
          unzip -q /tmp/awscliv2.zip -d /tmp
          /tmp/aws/install
        fi

        if ! command -v helm >/dev/null 2>&1; then
          curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
        fi
        if ! command -v just >/dev/null 2>&1; then
          apt-get install -y just || true
        fi
        if ! command -v just >/dev/null 2>&1; then
          arch="$(uname -m)"
          case "$arch" in
            aarch64|arm64) just_arch=aarch64 ;;
            x86_64|amd64) just_arch=x86_64 ;;
            *) echo "unsupported arch for just: $arch" >&2; exit 1 ;;
          esac
          curl -fsSL "https://github.com/casey/just/releases/download/1.42.4/just-1.42.4-${{just_arch}}-unknown-linux-musl.tar.gz" -o /tmp/just.tgz
          tar -xzf /tmp/just.tgz -C /tmp just
          install -m 0755 /tmp/just /usr/local/bin/just
        fi

        status source
        cd /
        rm -rf /opt/atrium
        mkdir -p /opt/atrium
        aws s3 cp "s3://$CONTROL_BUCKET/$CONTROL_PREFIX/source.tar.gz" /tmp/atrium-source.tar.gz
        tar -xzf /tmp/atrium-source.tar.gz -C /opt/atrium
        cd /opt/atrium
        git init -q
        git config user.email preview@atrium.local
        git config user.name "Atrium Preview"
        git add -A
        git commit -qm "preview source $COMMIT_SHA"

        status k3s
        mkdir -p /etc/rancher/k3s
        cat >/etc/rancher/k3s/config.yaml <<'YAML'
        disable:
          - traefik
          - servicelb
        write-kubeconfig-mode: "0644"
        YAML
        if ! systemctl is-active --quiet k3s 2>/dev/null; then
          curl -sfL https://get.k3s.io | sh -
        fi
        mkdir -p /root/.kube
        cp /etc/rancher/k3s/k3s.yaml /root/.kube/config
        export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
        ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl
        for i in $(seq 1 80); do
          kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready ' && break
          sleep 3
        done

        status registry
        REGISTRY_PORT=5000 /opt/atrium/deploy/setup-registry.sh
        /opt/atrium/deploy/setup-k3s.sh

        status surface-build
        mkdir -p /opt/atrium-deploy/pnpm-store
        docker run --rm \\
          -v /opt/atrium/surface:/app \\
          -v /opt/atrium-deploy/pnpm-store:/pnpm-store \\
          -w /app \\
          -e CI=true \\
          node:24-alpine \\
          sh -c 'corepack enable && pnpm config set store-dir /pnpm-store --global && pnpm install --frozen-lockfile && pnpm --filter @atrium/web build'

        TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' || true)"
        META_HEADER=()
        if [ -n "$TOKEN" ]; then META_HEADER=(-H "X-aws-ec2-metadata-token: $TOKEN"); fi
        PUBLIC_HOST="$(curl -fsS "${{META_HEADER[@]}}" http://169.254.169.254/latest/meta-data/public-hostname || true)"
        if [ -z "$PUBLIC_HOST" ]; then PUBLIC_HOST="$(curl -fsS "${{META_HEADER[@]}}" http://169.254.169.254/latest/meta-data/public-ipv4)"; fi
        PUBLIC_ORIGIN="http://$PUBLIC_HOST"

        status surface-initial
        cd /opt/atrium/surface/deploy
        cat >.env <<EOF
        DB_PASSWORD=$(openssl rand -hex 24)
        SESSION_SECRET=$(openssl rand -hex 32)
        PROVIDER_CREDENTIAL_SECRET=$(openssl rand -hex 32)
        APP_SIGNING_SECRET=$(openssl rand -hex 32)
        ARTIFACT_CAPTURE_API_KEY=$ARTIFACT_CAPTURE_API_KEY
        BIND_HOST=127.0.0.1
        DB_BIND_HOST=127.0.0.1
        SERVER_HOST_PORT=3001
        SITE_ADDRESS=:80
        HTTP_HOST_PORT=80
        S3_ENDPOINT=https://s3.$REGION.amazonaws.com
        S3_INTERNAL_ENDPOINT=https://s3.$REGION.amazonaws.com
        S3_BUCKET=$STORAGE_BUCKET
        S3_ACCESS_KEY=$S3_ACCESS_KEY
        S3_SECRET_KEY=$S3_SECRET_KEY
        MINIO_ACCESS_KEY=$S3_ACCESS_KEY
        MINIO_PASSWORD=$S3_SECRET_KEY
        AUTH_OPEN=1
        AUTH_DEV_CODES=1
        EMAIL_MODE=log
        APPS_ORIGIN=$PUBLIC_ORIGIN
        APPS_HOST=0.0.0.0
        APPS_PORT=3002
        CENTAUR_BASE_URL=
        CENTAUR_API_KEY=
        IRON_CONTROL_BASE_URL=
        IRON_CONTROL_API_KEY=
        IRON_CONTROL_NAMESPACE=default
        EOF

        cat >Caddyfile.aws-preview <<'EOF'
        :80 {{
          encode zstd gzip

          @apps path /apps/*
          handle @apps {{
            reverse_proxy server:3002
          }}

          @server path /api/* /auth/* /ws /healthz
          handle @server {{
            reverse_proxy server:3001
          }}

          handle {{
            root * /srv
            try_files {{path}} /index.html
            file_server
          }}
        }}
        EOF

        cat >docker-compose.aws-preview.yml <<'EOF'
        services:
          server:
            environment:
              ATRIUM_SERVER_PUBLICATION_HOST: 10.42.0.1
            ports: !override
              - "10.42.0.1:3001:3001"
          caddy:
            ports: !override
              - "0.0.0.0:80:80"
            volumes: !override
              - ./Caddyfile.aws-preview:/etc/caddy/Caddyfile:ro
              - ../web/dist:/srv:ro
              - caddy_data:/data
              - caddy_config:/config
        EOF

        docker compose --profile caddy -f docker-compose.prod.yml -f docker-compose.aws-preview.yml down -v || true
        docker compose --profile caddy -f docker-compose.prod.yml -f docker-compose.aws-preview.yml up -d --build
        for i in $(seq 1 80); do
          curl -fsS http://10.42.0.1:3001/healthz && break
          sleep 5
        done

        status centaur-build
        cd /opt/atrium/centaur
        for svc in api-rs iron-proxy sandbox node-sync console; do
          DOCKER_BUILDKIT=1 just build-one "$svc"
        done
        for img in centaur-api-rs centaur-iron-proxy centaur-agent centaur-node-sync centaur-console; do
          docker tag "$img:latest" "localhost:5000/library/$img:$COMMIT_SHA"
          docker push "localhost:5000/library/$img:$COMMIT_SHA"
          docker tag "$img:latest" "localhost:5000/library/$img:latest"
          docker push "localhost:5000/library/$img:latest"
        done

        status centaur-deploy
        export OP_SERVICE_ACCOUNT_TOKEN=dummy OP_VAULT=dummy SLACK_BOT_TOKEN=dummy SLACK_SIGNING_SECRET=dummy
        export SLACKBOT_API_KEY="$(openssl rand -hex 32)" LOCAL_DEV_API_KEY="$LOCAL_DEV_API_KEY"
        just bootstrap-secrets
        kubectl -n centaur patch secret centaur-infra-env --type merge \\
          -p "{{\\"stringData\\":{{\\"ARTIFACT_CAPTURE_API_KEY\\":\\"$ARTIFACT_CAPTURE_API_KEY\\"}}}}" >/dev/null
        mkdir -p /opt/atrium/.preview
        echo {values_b64!r} | base64 -d >/opt/atrium/.preview/centaur-values.yaml
        helm dependency update contrib/chart >/dev/null
        helm upgrade --install centaur contrib/chart -n centaur --create-namespace \\
          -f contrib/chart/values.dev.yaml \\
          -f /opt/atrium/infra/values.local.yaml \\
          -f /opt/atrium/.preview/centaur-values.yaml \\
          --set-string apiRs.image.tag="$COMMIT_SHA" \\
          --set-string ironProxy.image.tag="$COMMIT_SHA" \\
          --set-string sandbox.image.tag="$COMMIT_SHA" \\
          --set-string nodeSync.image.tag="$COMMIT_SHA" \\
          --set-string console.image.tag="$COMMIT_SHA"
        kubectl -n centaur rollout status deploy/centaur-centaur-api-rs --timeout=300s
        kubectl -n centaur rollout status deploy/centaur-centaur-console --timeout=300s
        kubectl -n centaur rollout status deploy/centaur-centaur-console-worker --timeout=300s
        kubectl -n centaur rollout status daemonset/centaur-centaur-node-sync --timeout=300s
        kubectl -n centaur patch svc centaur-centaur-api-rs -p '{{"spec":{{"type":"NodePort"}}}}' >/dev/null
        kubectl -n centaur patch svc centaur-centaur-console -p '{{"spec":{{"type":"NodePort"}}}}' >/dev/null
        API_NP="$(kubectl -n centaur get svc centaur-centaur-api-rs -o jsonpath='{{.spec.ports[0].nodePort}}')"
        CONSOLE_NP="$(kubectl -n centaur get svc centaur-centaur-console -o jsonpath='{{.spec.ports[0].nodePort}}')"
        GW="$(docker network inspect deploy_default -f '{{{{(index .IPAM.Config 0).Gateway}}}}')"
        IRON_KEY="$(kubectl -n centaur get secret centaur-infra-env -o jsonpath='{{.data.IRON_CONTROL_INITIAL_API_KEY}}' | base64 -d)"

        status surface-wire
        cd /opt/atrium/surface/deploy
        sed -i "s|^CENTAUR_BASE_URL=.*|CENTAUR_BASE_URL=http://$GW:$API_NP|" .env
        sed -i "s|^CENTAUR_API_KEY=.*|CENTAUR_API_KEY=$LOCAL_DEV_API_KEY|" .env
        sed -i "s|^IRON_CONTROL_BASE_URL=.*|IRON_CONTROL_BASE_URL=http://$GW:$CONSOLE_NP|" .env
        sed -i "s|^IRON_CONTROL_API_KEY=.*|IRON_CONTROL_API_KEY=$IRON_KEY|" .env
        docker compose --profile caddy -f docker-compose.prod.yml -f docker-compose.aws-preview.yml up -d server caddy
        for i in $(seq 1 80); do
          curl -fsS http://10.42.0.1:3001/healthz && break
          sleep 5
        done

        status smoke
        kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -fsS http://localhost:8080/healthz
        kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -fsS -X POST 'http://localhost:8080/api/session/cli%3Aaws-preview-smoke' \\
          -H "x-api-key: $LOCAL_DEV_API_KEY" \\
          -H 'content-type: application/json' \\
          -d '{{"harness_type":"codex","on_harness_conflict":"restart"}}'

        status ready
        cat >/var/lib/atrium-preview/ready.json <<EOF
        {{"preview_id":"$PREVIEW_ID","url":"$PUBLIC_ORIGIN","commit_sha":"$COMMIT_SHA","ready_at":"$(date -Is)"}}
        EOF
        aws s3 cp /var/lib/atrium-preview/ready.json "s3://$CONTROL_BUCKET/$CONTROL_PREFIX/ready.json" >/dev/null 2>&1 || true
        """
    )


def cloud_init(control_bucket: str, control_prefix: str) -> str:
    return textwrap.dedent(
        f"""\
        #cloud-config
        package_update: true
        packages:
          - curl
          - unzip
        runcmd:
          - |
            aws_arch="$(uname -m)"
            case "$aws_arch" in
              aarch64|arm64) aws_pkg=aarch64 ;;
              x86_64|amd64) aws_pkg=x86_64 ;;
              *) echo "unsupported arch for awscli: $aws_arch" >&2; exit 1 ;;
            esac
            curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${{aws_pkg}}.zip" -o /tmp/awscliv2.zip
          - rm -rf /tmp/aws
          - unzip -q /tmp/awscliv2.zip -d /tmp
          - /tmp/aws/install
          - mkdir -p /opt/atrium-preview
          - aws s3 cp s3://{control_bucket}/{control_prefix}/bootstrap.sh /opt/atrium-preview/bootstrap.sh
          - chmod +x /opt/atrium-preview/bootstrap.sh
          - nohup /opt/atrium-preview/bootstrap.sh >/var/log/atrium-preview-cloud-init.log 2>&1 &
        """
    )


def latest_ubuntu_ami(session: boto3.Session, region: str) -> str:
    ssm = session.client("ssm", region_name=region)
    return ssm.get_parameter(
        Name="/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
    )["Parameter"]["Value"]


def cmd_create(args: argparse.Namespace) -> None:
    region = args.region
    session = boto3.Session(profile_name=args.profile, region_name=region)
    acct = account_id(session)
    ec2 = session.client("ec2", region_name=region)
    s3 = session.client("s3", region_name=region)
    commit_sha = commit_for_ref(args.ref)
    preview_id = args.preview_id or make_preview_id(commit_sha)
    expires_at = now_utc() + dt.timedelta(hours=args.ttl_hours)
    control_bucket = args.control_bucket or f"atrium-preview-control-{acct}-{region}"
    storage_bucket = args.storage_bucket or f"atrium-{preview_id}-{acct}".replace("_", "-")
    control_prefix = f"previews/{preview_id}"

    print(f"creating {preview_id} from {commit_sha}")
    create_bucket(s3, control_bucket, region)
    create_bucket(s3, storage_bucket, region)
    profile_name = ensure_instance_role(session, control_bucket)
    sg_id = ensure_security_group(session, region)
    key_name = ensure_key_pair(session, region)
    s3_user = create_s3_user(session, preview_id, storage_bucket)

    source = package_source(commit_sha)
    s3.put_object(Bucket=control_bucket, Key=f"{control_prefix}/source.tar.gz", Body=source)
    artifact_key = secrets.token_hex(32)
    local_dev_key = secrets.token_hex(32)
    bootstrap = bootstrap_script(
        {
            "preview_id": preview_id,
            "commit_sha": commit_sha,
            "region": region,
            "control_bucket": control_bucket,
            "control_prefix": control_prefix,
            "storage_bucket": storage_bucket,
            "s3_access_key": s3_user["access_key_id"],
            "s3_secret_key": s3_user["secret_access_key"],
            "artifact_capture_api_key": artifact_key,
            "local_dev_api_key": local_dev_key,
        }
    )
    s3.put_object(Bucket=control_bucket, Key=f"{control_prefix}/bootstrap.sh", Body=bootstrap.encode())

    image_id = args.ami_id or latest_ubuntu_ami(session, region)
    user_data = cloud_init(control_bucket, control_prefix)
    tags = make_tags(preview_id, commit_sha) + [
        {"Key": "Name", "Value": f"atrium-{preview_id}"},
        {"Key": "ExpiresAt", "Value": expires_at.isoformat()},
    ]
    res = ec2.run_instances(
        ImageId=image_id,
        InstanceType=args.instance_type,
        MinCount=1,
        MaxCount=1,
        KeyName=key_name,
        IamInstanceProfile={"Name": profile_name},
        SecurityGroupIds=[sg_id],
        UserData=user_data,
        BlockDeviceMappings=[
            {
                "DeviceName": "/dev/sda1",
                "Ebs": {
                    "VolumeSize": args.volume_gb,
                    "VolumeType": "gp3",
                    "DeleteOnTermination": True,
                },
            }
        ],
        TagSpecifications=[
            {"ResourceType": "instance", "Tags": tags},
            {"ResourceType": "volume", "Tags": tags},
        ],
    )
    instance = res["Instances"][0]
    state = {
        "preview_id": preview_id,
        "region": region,
        "commit_sha": commit_sha,
        "instance_id": instance["InstanceId"],
        "control_bucket": control_bucket,
        "control_prefix": control_prefix,
        "storage_bucket": storage_bucket,
        "s3_user": s3_user["user"],
        "s3_access_key_id": s3_user["access_key_id"],
        "created_at": now_utc().isoformat(),
        "expires_at": expires_at.isoformat(),
        "status": "creating",
    }
    save_state(state)
    print(json.dumps({k: v for k, v in state.items() if k != "s3_access_key_id"}, indent=2))
    print(f"status: deploy/preview/aws/previewctl.py status {preview_id}")
    print(f"destroy: deploy/preview/aws/previewctl.py destroy {preview_id}")


def instance_for_state(session: boto3.Session, state: dict[str, Any]):
    ec2 = session.client("ec2", region_name=state["region"])
    res = ec2.describe_instances(InstanceIds=[state["instance_id"]])
    return res["Reservations"][0]["Instances"][0]


def cmd_status(args: argparse.Namespace) -> None:
    state = load_state(args.preview_id)
    session = boto3.Session(profile_name=args.profile, region_name=state["region"])
    inst = instance_for_state(session, state)
    s3 = session.client("s3", region_name=state["region"])
    public = inst.get("PublicDnsName") or inst.get("PublicIpAddress") or ""
    url = f"http://{public}" if public else None
    appliance_status = get_control_json(s3, state, "status.json")
    appliance_ready = get_control_json(s3, state, "ready.json")
    out = {
        "preview_id": state["preview_id"],
        "commit_sha": state["commit_sha"],
        "instance_id": state["instance_id"],
        "instance_state": inst["State"]["Name"],
        "phase": appliance_status.get("phase") if appliance_status else None,
        "phase_time": appliance_status.get("time") if appliance_status else None,
        "appliance_ready": bool(appliance_ready),
        "ready_at": appliance_ready.get("ready_at") if appliance_ready else None,
        "url": url,
        "storage_bucket": state.get("storage_bucket"),
        "expires_at": state.get("expires_at"),
    }
    print(json.dumps(out, indent=2))
    if url:
        print(f"health: curl -fsS {url}/healthz")
        print(f"ssh: ssh -i {STATE_DIR / (KEY_NAME + '.pem')} ubuntu@{public}")
        print("logs: sudo tail -f /var/log/atrium-preview-bootstrap.log")


def cmd_destroy(args: argparse.Namespace) -> None:
    state = load_state(args.preview_id)
    session = boto3.Session(profile_name=args.profile, region_name=state["region"])
    ec2 = session.client("ec2", region_name=state["region"])
    s3 = session.client("s3", region_name=state["region"])
    print(f"terminating {state['instance_id']}")
    try:
        ec2.terminate_instances(InstanceIds=[state["instance_id"]])
    except ClientError as err:
        if err.response["Error"]["Code"] != "InvalidInstanceID.NotFound":
            raise
    if args.wait:
        try:
            ec2.get_waiter("instance_terminated").wait(InstanceIds=[state["instance_id"]])
        except ClientError:
            pass
    for bucket in [state.get("storage_bucket")]:
        if bucket:
            print(f"deleting bucket {bucket}")
            try:
                empty_bucket(s3, bucket)
                s3.delete_bucket(Bucket=bucket)
            except ClientError as err:
                if err.response["Error"]["Code"] not in {"NoSuchBucket", "NotFound"}:
                    raise
    delete_s3_user(session, state.get("s3_user"))
    state["status"] = "destroyed"
    state["destroyed_at"] = now_utc().isoformat()
    save_state(state)
    print("destroyed")


def main() -> None:
    parser = argparse.ArgumentParser(description="Atrium AWS preview appliance controller")
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE", "atrium-preview"))
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", DEFAULT_REGION))
    sub = parser.add_subparsers(dest="cmd", required=True)

    create = sub.add_parser("create")
    create.add_argument("ref", nargs="?", default="HEAD")
    create.add_argument("--preview-id")
    create.add_argument("--ttl-hours", type=int, default=24)
    create.add_argument("--instance-type", default=DEFAULT_INSTANCE_TYPE)
    create.add_argument("--volume-gb", type=int, default=DEFAULT_VOLUME_GB)
    create.add_argument("--ami-id")
    create.add_argument("--control-bucket")
    create.add_argument("--storage-bucket")
    create.set_defaults(func=cmd_create)

    status = sub.add_parser("status")
    status.add_argument("preview_id")
    status.set_defaults(func=cmd_status)

    destroy = sub.add_parser("destroy")
    destroy.add_argument("preview_id")
    destroy.add_argument("--wait", action="store_true")
    destroy.set_defaults(func=cmd_destroy)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
