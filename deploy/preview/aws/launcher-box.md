# AWS Launcher Box

Small EC2 deployment for the preview launcher API.

## Current Shape

- Instance type: `t3a.micro`
- Region: `us-east-1`
- Service: `atrium-preview-launcher.service`
- Port: `8787`
- Auth: `Authorization: Bearer $PREVIEW_LAUNCHER_TOKEN`
- Local state file: `deploy/preview/aws/.state/launcher-box.json`

The security group currently allows SSH and launcher API access only from the
operator IP that created the box. Open additional ingress deliberately when
production Atrium is ready to call the launcher.

## Commands

Read local connection details:

```sh
cat deploy/preview/aws/.state/launcher-box.json
```

Health check:

```sh
URL="$(jq -r .url deploy/preview/aws/.state/launcher-box.json)"
TOKEN="$(jq -r .token deploy/preview/aws/.state/launcher-box.json)"
curl -fsS -H "authorization: Bearer $TOKEN" "$URL/healthz"
```

SSH:

```sh
HOST="$(jq -r .public_dns deploy/preview/aws/.state/launcher-box.json)"
ssh -i deploy/preview/aws/.state/atrium-preview-launcher.pem ubuntu@"$HOST"
```

Service logs:

```sh
sudo journalctl -u atrium-preview-launcher -f
```

Restart after pulling launcher changes:

```sh
cd /opt/atrium
sudo git fetch origin feat/fly-preview-environments
sudo git checkout origin/feat/fly-preview-environments
sudo /opt/atrium/deploy/preview/aws/.venv/bin/pip install -r /opt/atrium/deploy/preview/aws/requirements.txt
sudo systemctl restart atrium-preview-launcher
```

Create preview:

```sh
curl -fsS -X POST "$URL/previews" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"repo":"useatrium/atrium","ref":"my-branch","ttl_hours":24,"requested_by":"@agent"}'
```

## Cost

Approximate fixed launcher cost in `us-east-1`:

- `t3a.micro`: about `$0.0094/hr`
- 16 GiB gp3: about `$0.00175/hr`
- Total: about `$0.011/hr`, roughly `$8/month`

Preview appliances are separate and currently cost about `$0.168/hr` while
running.

## IAM Notes

The launcher role must be able to create, tag, list, and delete
`atrium-preview-*` IAM users and their inline policies/access keys. In
particular, destroy requires `iam:ListUserPolicies`; without it, EC2 termination
can succeed while per-preview IAM user cleanup fails.

The appliance role must be able to read and write the shared control bucket
prefix. The preview downloads `bootstrap.sh` and `source.tar.gz` from that
prefix, then uploads `status.json` and `ready.json` so the launcher can report
real bootstrap progress instead of treating Surface `/healthz` as full readiness.
