#!/usr/bin/env bash
# Assert the external surface of the five money-touching contracts is EXACTLY the allowlist.
#
# `test/v4/NoPrivilege.t.sol` asserts that nine specific forbidden selectors are absent. This
# asserts the complementary and stronger thing: that nothing NEW has appeared. The nine-selector
# test catches an implementer who adds `setCreatorFeeRecipient`; this catches one who adds
# `sweepTo(address)` — a name nobody thought to forbid, which is how the surface actually grows.
#
# It lives in a script rather than in a Foundry test because the answer comes from the compiled
# ABI, and reading `out/` from a test would mean granting `fs_permissions` on it. That permission
# was deliberately removed with the V3 tree, and it is the same permission whose stale artifacts
# once hid a completely broken DEX. `check-deps.sh` next door works the same way for the same
# reason.
#
# `fallback` and `receive` are checked too, and they are not decoration: a `fallback` makes every
# absent-function assertion in NoPrivilege.t.sol vacuous, because a raw call to a function that
# does not exist would start succeeding.
#
# Usage:  script/check-abi.sh            verify
#         script/check-abi.sh --update   rewrite the allowlist after a DELIBERATE surface change
set -uo pipefail
cd "$(dirname "$0")/.."

TARGETS=(
  "src/v4/DokuHook.sol:DokuHook"
  "src/sinks/BurnSink.sol:BurnSink"
  "src/sinks/RewardVault.sol:RewardVault"
  "src/sinks/CreatorSink.sol:CreatorSink"
  "src/DokuGraduation.sol:DokuGraduation"
)
ALLOWLIST="data/abi-allowlist.json"

surface() {
  # Methods, plus fallback/receive as pseudo-entries so a new one shows up as an addition.
  {
    forge inspect "$1" methods --json 2>/dev/null \
      | python3 -c 'import json,sys;print("\n".join(json.load(sys.stdin).keys()))'
    forge inspect "$1" abi --json 2>/dev/null \
      | python3 -c 'import json,sys;print("\n".join("<"+e["type"]+">" for e in json.load(sys.stdin) if e.get("type") in ("fallback","receive")))'
  } | grep -v '^$' | LC_ALL=C sort -u
}

# LC_ALL=C throughout: the shell's default collation and Python's `sorted()` disagree on case, so a
# locale-sorted list would differ from the generated allowlist on every capitalised constant and
# report a surface change on a repo that has not moved.

if [ "${1:-}" = "--update" ]; then
  python3 - "$ALLOWLIST" "${TARGETS[@]}" <<'PY'
import json, subprocess, sys
out, path = {}, sys.argv[1]
for t in sys.argv[2:]:
    m = json.loads(subprocess.run(["forge","inspect",t,"methods","--json"],capture_output=True,text=True).stdout or "{}")
    a = json.loads(subprocess.run(["forge","inspect",t,"abi","--json"],capture_output=True,text=True).stdout or "[]")
    extra = [f"<{e['type']}>" for e in a if e.get("type") in ("fallback","receive")]
    out[t.split(":")[1]] = sorted(set(list(m.keys()) + extra))
with open(path,"w") as f:
    json.dump(out, f, indent=2, sort_keys=True); f.write("\n")
print(f"allowlist rewritten: {path}")
PY
  exit 0
fi

[ -f "$ALLOWLIST" ] || { echo "FAIL: $ALLOWLIST missing. Run with --update to create it."; exit 1; }

fail=0
for t in "${TARGETS[@]}"; do
  name="${t##*:}"
  got=$(surface "$t")
  want=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print("\n".join(d.get(sys.argv[2],[])))' "$ALLOWLIST" "$name" | grep -v '^$' | LC_ALL=C sort -u)
  if [ "$got" != "$want" ]; then
    echo "SURFACE CHANGED  $name"
    diff <(echo "$want") <(echo "$got") | sed 's/^</  removed: /;s/^>/  ADDED:   /' | grep -E 'removed|ADDED'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "abi OK — ${#TARGETS[@]} contracts match $ALLOWLIST"
else
  echo
  echo "An ADDED selector is the one to look at. If it is deliberate, re-run with --update and say"
  echo "in the commit message why the surface grew. See docs/doku/08-plan-v4-hook-tax.md §4A."
fi
exit "$fail"
