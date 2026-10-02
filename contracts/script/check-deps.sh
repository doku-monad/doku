#!/usr/bin/env bash
# Verify contracts/lib matches dependencies.toml.
#
# WHICH COMMIT is vendored is now recorded by git itself: lib/ is four submodules, so the revisions
# live in the gitlinks (`git submodule status`) and the repo-root .gitmodules, and are mirrored in
# contracts/foundry.lock. dependencies.toml repeats them, and this script does something a commit
# pin cannot: it hashes what is actually ON DISK.
#
# That is the point. A gitlink says which commit was checked out; it says nothing about a submodule
# that was edited in place, half-updated, or left dirty. `forge build` compiles the modified tree
# without complaint. This recomputes each tree's fingerprint and compares it to the manifest, which
# is what turns a silent dependency drift — from either cause — into a failed check.
#
# It matters most for v4-periphery: the hook's mined address is derived from its creation code,
# which includes its whole import closure. If this script reports v4-periphery drift, the mined
# salt in deployments.md is stale and the hook will revert HookAddressNotValid on deploy.
#
# A tree reported MISSING usually just means the submodules were never fetched:
#   git submodule update --init --recursive        (from the repo root)
#
# Usage:  script/check-deps.sh          verify
#         script/check-deps.sh --update rewrite fingerprints after a deliberate bump
set -uo pipefail
cd "$(dirname "$0")/.."

fingerprint() {
  find "lib/$1" -name '*.sol' -type f -print0 2>/dev/null \
    | sort -z | xargs -0 shasum -a 256 2>/dev/null | shasum -a 256 | cut -c1-16
}

[ -f dependencies.toml ] || { echo "FAIL: dependencies.toml missing"; exit 1; }

fail=0; checked=0
while read -r name want; do
  [ -d "lib/$name" ] || { echo "MISSING   $name — not installed. See dependencies.toml."; fail=1; continue; }
  got=$(fingerprint "$name"); checked=$((checked+1))
  if [ "${1:-}" = "--update" ]; then
    [ "$got" = "$want" ] || { echo "updating  $name  $want -> $got"; 
      python3 - "$name" "$got" <<'PY'
import re,sys,pathlib
name,got=sys.argv[1],sys.argv[2]
p=pathlib.Path('dependencies.toml'); s=p.read_text()
s=re.sub(r'(\['+re.escape(name)+r'\][^\[]*?fingerprint\s*=\s*")[0-9a-f]{16}(")', r'\g<1>'+got+r'\g<2>', s, flags=re.S)
p.write_text(s)
PY
    }
  elif [ "$got" != "$want" ]; then
    echo "DRIFT     $name  manifest=$want  actual=$got"
    [ "$name" = "v4-periphery" ] && echo "          ^^ this invalidates the mined hook salt in deployments.md"
    fail=1
  fi
done < <(python3 - <<'PY'
import re,pathlib
s=pathlib.Path('dependencies.toml').read_text()
for m in re.finditer(r'\[([\w.-]+)\][^\[]*?fingerprint\s*=\s*"([0-9a-f]{16})"', s, re.S):
    print(m.group(1), m.group(2))
PY
)

if [ "${1:-}" = "--update" ]; then echo "manifest updated"; exit 0; fi
[ "$fail" -eq 0 ] && echo "deps OK — $checked trees match dependencies.toml"
exit "$fail"
