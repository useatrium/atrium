# Atrium AWS Preview Appliances

This is the AWS-only preview path: one disposable EC2 instance per preview,
running Surface with Docker Compose and Centaur with local k3s.

The goal is to match the current OVH production shape closely enough that live
agents, `node-sync`, and artifact rendering can be tested without mixing Fly and
AWS networking.

## Local Setup

Install dependencies:

```sh
python3 -m venv deploy/preview/aws/.venv
deploy/preview/aws/.venv/bin/pip install -r deploy/preview/aws/requirements.txt
```

Configure a temporary AWS profile:

```sh
aws configure --profile atrium-preview
AWS_PROFILE=atrium-preview aws sts get-caller-identity
```

The temporary key currently needs broad permissions for the spike. After the
first working deploy, replace it with a scoped policy.

## Create

```sh
deploy/preview/aws/.venv/bin/python deploy/preview/aws/previewctl.py create HEAD
```

Defaults:

- region: `us-east-1`
- instance: `t4g.xlarge`
- root EBS: `160` GB gp3
- TTL tag: 24 hours

The controller:

1. creates a control S3 bucket for source/bootstrap files;
2. creates a per-preview S3 bucket for Atrium files/apps;
3. creates a per-preview IAM user/access key scoped to that storage bucket;
4. creates/reuses an EC2 role, instance profile, key pair, and security group;
5. uploads a `git archive` of the requested commit;
6. launches Ubuntu 24.04 ARM64;
7. bootstraps Docker, k3s, Surface, Centaur, local registry, and Caddy.

## Status

```sh
deploy/preview/aws/.venv/bin/python deploy/preview/aws/previewctl.py status prev-...
```

Once the instance is running, SSH is:

```sh
ssh -i deploy/preview/aws/.state/atrium-preview-appliance.pem ubuntu@<public-host>
```

Useful remote logs:

```sh
sudo tail -f /var/log/atrium-preview-bootstrap.log
cat /var/lib/atrium-preview/status.json
cat /var/lib/atrium-preview/ready.json
```

## Destroy

```sh
deploy/preview/aws/.venv/bin/python deploy/preview/aws/previewctl.py destroy prev-... --wait
```

Destroy terminates the EC2 instance, deletes the per-preview storage bucket, and
deletes the per-preview S3 IAM user/access keys. The shared control bucket,
security group, instance profile, role, and EC2 key pair are retained for reuse.

## Known Limitations

- First boot builds Centaur images on the preview instance, so startup can be
  slow.
- HTTP only for the first spike. Add Route53/ACM/Caddy TLS after the full stack
  works.
- The Surface S3 client currently requires explicit access key env vars, so the
  controller creates a per-preview IAM user instead of relying only on the EC2
  instance profile.
