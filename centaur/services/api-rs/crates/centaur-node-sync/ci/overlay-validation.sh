#!/usr/bin/env bash
# On-node syscall validation for the overlay scanner — runs in CI on a privileged
# Linux runner (GitHub ubuntu-latest supports overlayfs + sudo). Builds scan-demo,
# mounts a REAL overlay, exercises create/modify/delete/rename/symlink, and asserts
# the scanner's classification + the openat2 symlink-escape block. Locks in the
# proofs (whiteout→Delete, symlink→metadata-only, openat2 ELOOP) that previously
# only ran by hand on the kind node. Run from services/api-rs.
set -euo pipefail

cargo build -p centaur-node-sync --bin scan-demo
BIN="${CARGO_TARGET_DIR:-$(pwd)/target}/debug/scan-demo"
WORK="$(mktemp -d)"

sudo mkdir -p "$WORK"/{lower,upper,work,merged}
echo base | sudo tee "$WORK/lower/keep.md" >/dev/null
echo del  | sudo tee "$WORK/lower/del.md"  >/dev/null
sudo mount -t overlay overlay \
  -o "lowerdir=$WORK/lower,upperdir=$WORK/upper,workdir=$WORK/work,metacopy=off" \
  "$WORK/merged"

cleanup() { sudo umount "$WORK/merged" 2>/dev/null || true; }
trap cleanup EXIT

echo edit | sudo tee -a "$WORK/merged/keep.md" >/dev/null   # modify  -> copy-up
sudo rm "$WORK/merged/del.md"                                # delete  -> whiteout (char 0:0)
echo new  | sudo tee "$WORK/merged/new.md" >/dev/null        # create  -> upsert
sudo ln -s /etc/shadow "$WORK/merged/leak"                   # symlink escape attempt

echo "=== scanner classification ==="
OUT="$(sudo "$BIN" "$WORK/upper")"
echo "$OUT"
# scan-demo prints Rust Debug with " replaced by ' (e.g. Delete { path: 'del.md' })
grep -q "Delete { path: 'del.md'"      <<<"$OUT" || { echo "FAIL: whiteout not classified Delete"; exit 1; }
grep -q "Upsert { path: 'new.md'"      <<<"$OUT" || { echo "FAIL: new file not Upsert"; exit 1; }
grep -q "Upsert { path: 'keep.md'"     <<<"$OUT" || { echo "FAIL: modified file not Upsert"; exit 1; }
grep -q "SymlinkMeta { path: 'leak'"   <<<"$OUT" || { echo "FAIL: symlink not metadata-only"; exit 1; }
echo "  ✓ whiteout→Delete, create/modify→Upsert, symlink→metadata-only"

echo "=== openat2 symlink-escape block (#1) ==="
if sudo "$BIN" --read "$WORK/upper" leak >/dev/null 2>&1; then
  echo "FAIL: openat2 did NOT block the symlink escape to /etc/shadow"; exit 1
fi
echo "  ✓ openat2 NO_SYMLINKS blocked leak→/etc/shadow (ELOOP)"
# and a regular file DOES read through
sudo "$BIN" --read "$WORK/upper" new.md | grep -q new || { echo "FAIL: hardened read of a regular file failed"; exit 1; }
echo "  ✓ hardened read of a regular file works"

echo "✅ overlay scanner validation PASSED"
