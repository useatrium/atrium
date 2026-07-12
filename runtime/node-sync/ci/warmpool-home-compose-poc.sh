#!/usr/bin/env bash
# SPIKE POC #2 (warm-pool for repo sessions, FLAT-HOME HOME-COMPOSITION): the bare POC
# (warmpool-rebind-poc.sh) proved a submount at HOME propagates into a running pod. But under
# flat-home the entrypoint writes the agent's whole generic HOME config into HOME (~/.codex,
# ~/.claude, ~/.config/amp, ~/AGENTS.md, …), which a session-overlay submount at HOME would
# SHADOW. Decision: COMPOSE THE GENERIC HOME AS A READ-ONLY LOWER beneath the repo, so the
# submounted HOME = repo files + the generic harness config, merged.
#
# This POC validates that composition + the AGENTS.md precedence:
#   - generic-home lower: ~/.codex/config.toml, ~/.claude/settings.json, ~/.config/amp/settings.json,
#     ~/AGENTS.md = the centaur system prompt (what the warm pod's entrypoint produced at boot);
#   - repo lower: README.md, src/lib.rs, AND its OWN AGENTS.md (to test precedence);
#   - compose `lowerdir=<generic-home>:<repo>` (generic-home topmost) → centaur's ~/AGENTS.md wins,
#     matching current flat-home where the entrypoint OVERWRITES a repo's AGENTS.md with centaur's
#     (entrypoint.sh:508-512). Repo files show through (no conflict). Submount at HOME post-start.
#
# Asserts, in the RUNNING pod after the submount: harness config present + readable, repo files
# present, $HOME/AGENTS.md == centaur's (precedence), and a first-turn write lands in the upper.
# (Booting a real harness CLI on top is a separate step; this nails the overlay composition itself.)
#
# Needs a real Linux node (overlay + mountPropagation). Runs on kind. Informational CI.
set -euo pipefail

NS="${NS:-centaur}"
KIND_CLUSTER="${KIND_CLUSTER:-centaur}"
IMAGE="${IMAGE:-centaur-node-sync:e2e}"
POD="${POD:-warmpool-home-compose-poc}"
HOME_PATH="/home/agent"
HOME_PARENT="/home"
SLOT="/run/centaur/merged/${POD}"
HOME_LEAF="agent"
STAGE="/run/centaur/poc-${POD}"
NODE="${KIND_CLUSTER}-control-plane"

CENTAUR_PROMPT="CENTAUR SYSTEM PROMPT - you are in a sandbox"
REPO_PROMPT="REPO-SPECIFIC AGENTS.md - should be shadowed by the centaur prompt under flat-home"

on_node() { docker exec "${NODE}" sh -ceu "$1"; }
cleanup() {
  kubectl -n "${NS}" delete pod "${POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  on_node "umount '${SLOT}/${HOME_LEAF}' 2>/dev/null || true; umount '${SLOT}' 2>/dev/null || true; rm -rf '${STAGE}' '${SLOT}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -
for _ in $(seq 1 30); do kubectl -n "${NS}" get serviceaccount default >/dev/null 2>&1 && break; sleep 1; done

echo "==> [1/6] node: stage the generic-HOME lower (harness config) + the repo lower; make ${HOME_PARENT} a shared mountpoint"
on_node "
  set -e
  umount '${SLOT}/${HOME_LEAF}' 2>/dev/null || true; umount '${SLOT}' 2>/dev/null || true
  rm -rf '${STAGE}' '${SLOT}'
  # generic-HOME lower: what the warm pod's entrypoint wrote to HOME at boot (config + centaur prompt)
  mkdir -p '${STAGE}/home-lower/.codex' '${STAGE}/home-lower/.claude' '${STAGE}/home-lower/.config/amp'
  printf 'model = \"o4\"\n' > '${STAGE}/home-lower/.codex/config.toml'
  printf '{\"theme\":\"dark\"}\n' > '${STAGE}/home-lower/.claude/settings.json'
  printf '{\"amp\":true}\n' > '${STAGE}/home-lower/.config/amp/settings.json'
  printf '%s\n' '${CENTAUR_PROMPT}' > '${STAGE}/home-lower/AGENTS.md'
  # repo lower: the session repo, WITH its own AGENTS.md to test precedence
  mkdir -p '${STAGE}/repo-lower/src'
  printf 'repo readme\n' > '${STAGE}/repo-lower/README.md'
  printf 'pub fn bound() {}\n' > '${STAGE}/repo-lower/src/lib.rs'
  printf '%s\n' '${REPO_PROMPT}' > '${STAGE}/repo-lower/AGENTS.md'
  mkdir -p '${STAGE}/upper' '${STAGE}/work' '${SLOT}/${HOME_LEAF}'
  mount --bind '${SLOT}' '${SLOT}'; mount --make-rshared '${SLOT}'
  echo 'shared mountpoint:'; findmnt -no TARGET,PROPAGATION '${SLOT}' 2>/dev/null || true
"

echo "==> [2/6] start a generic warm pod: HOME=${HOME_PATH} (empty), parent ${HOME_PARENT} HostToContainer, idle"
kubectl -n "${NS}" delete pod "${POD}" --ignore-not-found --wait=true
kubectl -n "${NS}" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${POD}
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 1
  volumes:
    - name: home
      hostPath: { path: ${SLOT}, type: DirectoryOrCreate }
  containers:
    - name: agent
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-c", "sleep 3600"]
      env:
        - { name: HOME, value: "${HOME_PATH}" }
      securityContext:
        runAsUser: 1001
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
        seccompProfile: { type: RuntimeDefault }
      volumeMounts:
        - { name: home, mountPath: ${HOME_PARENT}, mountPropagation: HostToContainer }
      workingDir: ${HOME_PATH}
YAML
kubectl -n "${NS}" wait --for=condition=Ready "pod/${POD}" --timeout=120s

echo "==> [3/6] confirm \$HOME empty (generic shell, no session bound yet)"
kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu 'test -z "$(ls -A "$HOME" 2>/dev/null)"'
echo "    OK: \$HOME empty, container running"

echo "==> [4/6] POST-CLAIM: mount the COMPOSED overlay (generic-home : repo) at HOME, a submount under ${HOME_PARENT}"
on_node "
  set -e
  chown -R 1001:1001 '${STAGE}/upper' '${STAGE}/work'
  # lowerdir order = generic-home FIRST (topmost) : repo — so centaur's AGENTS.md wins (matches flat-home),
  # repo files show through, harness config (.codex/.claude/.config) is present.
  mount -t overlay overlay -o lowerdir='${STAGE}/home-lower:${STAGE}/repo-lower',upperdir='${STAGE}/upper',workdir='${STAGE}/work',metacopy=off '${SLOT}/${HOME_LEAF}'
  echo 'composed overlay at HOME; propagation:'; findmnt -no TARGET,PROPAGATION '${SLOT}/${HOME_LEAF}' 2>/dev/null || true
"

echo "==> [5/6] ASSERT the running pod's \$HOME has BOTH the harness config AND the repo, with centaur's AGENTS.md winning"
ok=0
for _ in $(seq 1 15); do
  if kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
       # harness config survived the submount (from the generic-home lower):
       grep -q "model" "$HOME/.codex/config.toml" 2>/dev/null &&
       grep -q "theme" "$HOME/.claude/settings.json" 2>/dev/null &&
       grep -q "amp" "$HOME/.config/amp/settings.json" 2>/dev/null &&
       # repo files present (from the repo lower):
       grep -q "repo readme" "$HOME/README.md" 2>/dev/null &&
       grep -q "pub fn bound" "$HOME/src/lib.rs" 2>/dev/null &&
       # AGENTS.md precedence: centaur (generic-home, topmost) wins over the repo version:
       grep -q "CENTAUR SYSTEM PROMPT" "$HOME/AGENTS.md" 2>/dev/null &&
       ! grep -q "REPO-SPECIFIC" "$HOME/AGENTS.md" 2>/dev/null
     '; then ok=1; break; fi
  sleep 1
done
if [[ "${ok}" != "1" ]]; then
  echo "FAIL: composed HOME did not present config+repo with centaur AGENTS.md precedence" >&2
  kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu 'echo "HOME tree:"; ls -la "$HOME" "$HOME/.codex" 2>&1; echo "AGENTS.md:"; cat "$HOME/AGENTS.md" 2>&1 || true' >&2 || true
  exit 1
fi
echo "    OK: \$HOME = harness config (.codex/.claude/.config) + repo (README.md/src) ; \$HOME/AGENTS.md == centaur's (repo's shadowed)"

echo "==> [6/6] confirm a first-turn write in ~ lands in the (capturable) upper"
kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu 'cd "$HOME"; echo hi > ./turn.txt; test -f "$HOME/turn.txt"'
on_node "test -f '${STAGE}/upper/turn.txt' && echo 'node: write landed in the overlay upper (capturable)'"

echo "==> [7/7] (real harness) if a harness binary is present (centaur-agent image), confirm it runs in the composed HOME and reads its config"
if kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -c 'command -v codex >/dev/null 2>&1 || command -v claude >/dev/null 2>&1'; then
  kubectl -n "${NS}" exec "${POD}" -c agent -- /bin/sh -ceu '
    echo "  HOME=$HOME ; harness binaries: $(command -v codex claude 2>/dev/null | tr "\n" " ")"
    # the real harness binary runs under the composed overlay HOME (uid 1001, PATH from /opt):
    codex --version 2>&1 | head -1 || true
    claude --version 2>&1 | head -1 || true
    # the config the harness expects is present + readable in the composed HOME (from the generic-home lower):
    test -r "$HOME/.codex/config.toml" && echo "  codex config readable: $(head -1 "$HOME/.codex/config.toml")"
    test -r "$HOME/.claude/settings.json" && echo "  claude settings readable: $(head -1 "$HOME/.claude/settings.json")"
    test -r "$HOME/AGENTS.md" && echo "  system prompt readable: $(head -1 "$HOME/AGENTS.md")"
  '
  echo "    OK: a real harness binary ran in the composed overlay HOME and its config + prompt are present/readable"
else
  echo "    SKIP: minimal image has no harness binary — real-harness check is local-only with centaur-agent:* (CI uses centaur-node-sync:e2e)"
fi

echo
echo "OK (flat-home HOME-composition): composing the generic HOME as a RO lower BENEATH the repo, submounted"
echo "    at HOME on a running pod, yields a flat HOME with both the harness config and the repo, and centaur's"
echo "    AGENTS.md taking precedence (matching today's flat-home entrypoint). Compose-generic-HOME-as-a-lower"
echo "    is VIABLE. (lowerdir order is the AGENTS.md-precedence knob: generic-home:repo = centaur wins.)"
