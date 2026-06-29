#!/usr/bin/env bash
set -euo pipefail

script="contrib/scripts/bootstrap-k8s-secrets.sh"

if grep -Eq 'patch_data\+=\("\\"GITHUB_TOKEN\\"|--from-literal=GITHUB_TOKEN' "$script"; then
  echo "::error title=GitHub token infra demotion::${script} must not seed GITHUB_TOKEN into centaur-infra-env"
  exit 1
fi

if ! grep -Fq '"op":"remove","path":"/data/GITHUB_TOKEN"' "$script"; then
  echo "::error title=GitHub token infra demotion::${script} must remove legacy data.GITHUB_TOKEN from centaur-infra-env"
  exit 1
fi

echo "GitHub bootstrap demotion check passed."
